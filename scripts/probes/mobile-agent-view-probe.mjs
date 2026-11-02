/**
 * Acceptance check probe for mobile app Agent tab "How chat view is rendered" (paired with
 * `mobile-agent-probe.mjs`: that one tests start page, quotes, and tabs on real pages; this one
 * tests how chat view is rendered using mock messages).
 * No cloud connection, no project connection: `src/mobile/agent-harness.tsx` renders the chat view
 * (`AgentChatView`) and tab row in isolation, served via vite middleware mode;
 * Opens the Agent page of demo `prototypes/mobile-ui-demo/` at the same dimensions (375×812,
 * touchscreen) for side-by-side comparison.
 *
 *   node scripts/probes/mobile-agent-view-probe.mjs [--out <screenshot directory>] [--port 5985]
 *
 * Acceptance check (each failure enters `fails` in the final JSON line as one item per line):
 *   V1 My bubble aligned right, Agent bubble aligned left, max bubble width 88%; quotes at message
 *      start rendered as badge ("@ name"), read-only, no ✕;
 *   V2 Operation card: "Agent operations" label + "Round N · M operations", latest round and active
 *      round expanded by default, earlier rounds collapsed, clicking title toggles collapse / expand;
 *      Item status: completed (green), failed (red), in progress (cyan flashing), not started (gray);
 *      summary completed / pending / issues become rows in the card;
 *   V3 Three dots "what it is currently doing" at end of running round; failed round displays reason;
 *      messages not yet accepted by cloud show sending status;
 *   V4 Quote bar: above input box, bottom edge ≤ input box top edge, dimensions match demo (badge
 *      height, ✕ 18×18); when quote present, input box placeholder is "@name how would you like to edit?";
 *   V5 Start page: upon entering project, has light dot + arrow (animation turned off when reduce
 *      motion is enabled), input box has guide outline; after clicking preset, send button has guide;
 *      after manual clearing, no light dot and arrow;
 *   V6 Chat tab row: each session tab has ✕; busy sessions have flashing dot; long titles truncated
 *      without expanding width; when no sessions, only one "Start" item without ✕;
 *   V7 Send button: swapped to stop button when running and input box is empty;
 *   V8 No horizontal overflow at 375 width, no page errors.
 * Screenshots: `view-*.png`, side-by-side `side-view-*.png` with demo. Final line of results is a
 * single line of JSON (`ok`, `fails`, each metric).
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer';
import { createServer as createViteServer } from 'vite';
// This vite instance does not use vite.config.ts, aliases must be attached manually (if omitted,
// browser-side transform 500, page fails to open)
import { cloudSeamsPlugin } from '../../server/vite-plugin-cloud-seams.ts';
import react from '@vitejs/plugin-react';
import { PNG } from 'pngjs';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { DEVICES } from './lib/mobile-env.mjs';

setTimeout(() => { console.error('SCRIPT_TIMEOUT'); process.exit(124); }, 6 * 60_000).unref();

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), 'mobile-agent-view-shots')));
const PORT = Number(arg('--port', 5985));
const DEMO = path.join(ROOT, 'prototypes', 'mobile-ui-demo', 'index.html');
if (PORT < 5980 || PORT > 5989) throw new Error(`Port ${PORT} is not in the 5980-5989 range assigned to this probe`);
fs.mkdirSync(OUT, { recursive: true });

const fails = [];
const out = { ok: false, out: OUT, V1: {}, V2: {}, V3: {}, V4: {}, V5: {}, V6: {}, V7: {}, V8: {} };
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 500))); return !!cond; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;

function sideBySide(left, right, file) {
  const a = PNG.sync.read(fs.readFileSync(left)), b = PNG.sync.read(fs.readFileSync(right));
  const h = Math.max(a.height, b.height), w = a.width + 16 + b.width;
  const o = new PNG({ width: w, height: h });
  o.data.fill(40);
  PNG.bitblt(a, o, 0, 0, a.width, a.height, 0, 0);
  PNG.bitblt(b, o, 0, 0, b.width, b.height, a.width + 16, 0);
  fs.writeFileSync(file, PNG.sync.write(o));
}
const portOpen = (port) => new Promise((resolve) => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); resolve(true); }); s.once('error', () => resolve(false)); });
if (await portOpen(PORT)) throw new Error(`Port ${PORT} is already in use`);

const vite = await createViteServer({ configFile: false, root: ROOT, plugins: [cloudSeamsPlugin(), react()], appType: 'custom', logLevel: 'error',
  server: { middlewareMode: true, hmr: false, fs: { strict: true, deny: ['**/.git/**', '**/out/**', '**/.env*', '**/*.{pem,key,crt}'] } } });
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, `http://127.0.0.1:${PORT}`).pathname;
  if (pathname === '/' || pathname === '/harness.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>html,body{margin:0;height:100%;background:#07090c}</style></head><body><div id="root"></div><script type="module" src="/src/mobile/agent-harness.tsx"></script></body></html>');
    return;
  }
  if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  if (!pathname.startsWith('/src/') && !pathname.startsWith('/node_modules/') && !pathname.startsWith('/@') && !pathname.startsWith('/__vite') && !pathname.startsWith('/server/')) { res.writeHead(404); res.end(); return; }
  vite.middlewares(req, res, () => { res.writeHead(404); res.end(); });
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, '127.0.0.1', resolve); });

const browser = await puppeteer.launch({ headless: true, ignoreDefaultArgs: ['--hide-scrollbars'], protocolTimeout: 300_000, args: [...PROBE_CHROME_ARGS, '--no-first-run'] });
const pages = [];
async function phone() {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e?.message ?? e)));
  page.on('console', (m) => { if (m.type() === 'error') page.errors.push(`console:${m.text()}`); });
  const d = DEVICES.phone;
  await page.setViewport(d.viewport);
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setUserAgentOverride', { userAgent: d.ua, userAgentMetadata: d.meta });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  page.cdp = cdp;
  pages.push(ctx);
  return page;
}

const now = Date.now();
const tool = (name, input = {}, ok) => ({ kind: 'tool', name: `mcp__promptcut__${name}`, input, ...(ok === undefined ? {} : { ok }) });
const say = (text) => tool('send_message', { to: 'user', text }, true);
const MSGS = [
  { id: 'u1', role: 'user', text: 'Add a title to the opening with a summery feel, then add some relaxing music' },
  { id: 'a1', role: 'assistant', text: '', startedAt: now, finishedAt: now, outcome: 'completed', parts: [
    say('OK, I took a look at the first 6 seconds of footage and plan to use a large handwritten-feel title + warm tones. Doing it now.'),
    tool('list_media', {}, true), tool('add_clip', {}, true), tool('set_clip_param', {}, false), tool('see_frames', {}, true),
    tool('report_progress', { final: true, done: ['Created text motion graphics card "Summer seaside"'], todo: ['Check whether the music conflicts with the captions'], problems: ['Font missing, used the default font for now'] }, true),
    say('The title and music are both in place. You can drag the title directly in the preview, or tell me how you want to change it.'),
  ] },
  { id: 'u2', role: 'user', text: '@card beach-run.mp4(c-9) Trim this clip a bit' },
  { id: 'a2', role: 'assistant', text: '', startedAt: now, pending: true, progress: { phase: 'run', text: 'Reading the current timeline and the clip you referenced' }, parts: [tool('get_project', {}, true), tool('split_clip', {})] },
];
const TABS2 = [{ id: 't1', title: 'Agent 1' }, { id: 't2', title: 'Agent 2' }];
const base = { tabs: TABS2, activeId: 't1', messages: MSGS, quotes: [], draft: false, animated: false, guide: null, inputText: '', streaming: false };

try {
  const A = await phone();
  await A.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  await A.waitForFunction(() => !!window.__agentHarness, { timeout: 120_000 });
  const render = async (s) => { await A.evaluate((st) => window.__agentHarness.render(st), s); await sleep(500); };
  const rects = (sel) => A.evaluate((s) => [...document.querySelectorAll(s)].map((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom }; }), sel);
  const shot = (name) => A.screenshot({ path: path.join(OUT, `${name}.png`) });

  /* ================================================================ V1~V3 chat */
  await render({ ...base, messages: MSGS });
  await shot('view-chat');
  {
    const box = (await rects('[data-pcm="chat-msgs"]'))[0];
    const me = await rects('[data-pcm="msg-me"]'), ag = await rects('[data-pcm="msg-ag"]');
    out.V1 = { box, me, ag: ag.slice(0, 3) };
    check(me.length === 2 && me.every((m) => near(m.r, box.r - 14, 2) && m.w <= box.w * 0.88 + 30), 'V1 my bubbles are right-aligned, at most 88% wide', { me, box });
    check(ag.length >= 2 && ag.every((m) => near(m.x, box.x + 14, 2) && m.w <= box.w * 0.88 + 30), 'V1 Agent bubbles are left-aligned, at most 88% wide', { ag, box });
    const refs = await A.evaluate(() => [...document.querySelectorAll('[data-pcm="msg-me"] [data-pcm="ref-tag"]')].map((e) => ({ t: e.textContent.trim(), x: !!e.querySelector('b') })));
    check(refs.length === 1 && refs[0].t === '@ beach-run.mp4' && !refs[0].x, 'V1 the quote at the start of a message is drawn as a read-only tag (no ✕)', refs);
    const mine = await A.evaluate(() => [...document.querySelectorAll('[data-pcm="msg-me"]')].map((e) => e.querySelector('.plain')?.textContent));
    check(mine[1] === 'Trim this clip a bit', 'V1 the quote string was removed from the body text', mine);
    const who = await A.evaluate(() => [...document.querySelectorAll('[data-pcm="msg-ag"] .who')].map((e) => e.textContent));
    check(who.length >= 2 && who.every((w) => w === 'Agent 1'), 'V1 the Agent bubble is labeled with which session it is', who);

    const cards = await A.evaluate(() => [...document.querySelectorAll('[data-pcm="ops-card"]')].map((c) => ({
      open: c.open, tag: c.querySelector('summary .chip')?.textContent, title: c.querySelector('summary')?.textContent.trim(), w: c.getBoundingClientRect().width,
      items: [...c.querySelectorAll('.it')].map((i) => ({ cls: i.className.replace('it ', ''), mk: i.querySelector('.mk').textContent, text: i.textContent.trim().slice(0, 40) })),
      reps: [...c.querySelectorAll('.rep-title')].map((e) => e.textContent),
    })));
    out.V2 = cards;
    check(cards.length === 2 && cards[0].tag === 'Agent actions' && cards[0].title === 'Agent actions round 1 · 4 actions' && cards[1].title === 'Agent actions round 2 · 2 actions', 'V2 action card: "Agent actions" + round N · M actions', cards.map((c) => c.title));
    check(cards[1].open === true && cards[0].open === false, 'V2 the running round (the latest) is expanded by default, the older round is collapsed', cards.map((c) => c.open));
    // Click title to expand an earlier round
    const sum0 = (await rects('[data-pcm="ops-card"] summary'))[0];
    await A.touchscreen.tap(sum0.x + 40, sum0.y + sum0.h / 2);
    await sleep(300);
    const opened = await A.evaluate(() => [...document.querySelectorAll('[data-pcm="ops-card"]')].map((c) => c.open));
    check(opened[0] === true, 'V2 clicking the title expands the older round', opened);
    const c0 = await A.evaluate(() => [...document.querySelectorAll('[data-pcm="ops-card"]')[0].querySelectorAll('.it')].map((i) => ({ cls: i.className.replace('it ', ''), mk: i.querySelector('.mk').textContent, text: i.textContent.trim() })));
    check(c0.slice(0, 4).map((i) => i.cls).join() === 'done,done,err,done' && c0[0].text.includes('Read list_media') && c0[1].text.includes('Add add_clip') && c0[2].text.includes('Modify set_clip_param'), 'V2 entries: category + tool name, status done / failed', c0);
    check(c0.slice(4).map((i) => i.cls).join() === 'done,todo,ask' && c0[4].text.includes('Summer seaside') && c0[6].text.includes('Font missing'), 'V2 the summary\'s done / to-do / issues become rows in the card', c0);
    const c1 = await A.evaluate(() => [...document.querySelectorAll('[data-pcm="ops-card"]')[1].querySelectorAll('.it')].map((i) => i.className.replace('it ', '')));
    check(c1.join() === 'done,run', 'V2 the running round: the last item is "in progress"', c1);
    const colors = await A.evaluate(() => {
      const bg = (s) => getComputedStyle(document.querySelector(s)).backgroundColor;
      return { done: bg('.it.done .mk'), err: bg('.it.err .mk'), run: bg('.it.run .mk'), ask: bg('.it.ask .mk'), todo: bg('.it.todo .mk') };
    });
    out.V2.colors = colors;
    check(colors.done === 'rgb(76, 195, 138)' && colors.err === 'rgb(229, 96, 79)' && colors.run === 'rgb(38, 198, 230)' && colors.ask === 'rgb(232, 176, 74)', 'V2 status colors: done green, failed red, in progress cyan-blue, issue yellow (same variables as the demo mockup)', colors);
    const typing = await A.evaluate(() => ({ dots: document.querySelectorAll('[data-pcm="msg-typing"] .typing i').length, text: document.querySelector('[data-pcm="msg-typing"] .act')?.textContent }));
    out.V3.typing = typing;
    check(typing.dots === 3 && typing.text === 'Reading the current timeline and the clip you referenced', 'V3 the round still running ends with three dots and "what it is doing now"', typing);
    await shot('view-chat-open');
  }
  // Errors, sending status
  await render({ ...base, messages: [
    { id: 'u1', role: 'user', text: 'Hello', sendState: 'sending' },
    { id: 'u2', role: 'user', text: 'One more', sendState: 'accepted' },
    { id: 'u3', role: 'user', text: 'This one was not sent', sendState: 'failed', error: 'Please read and confirm the notice before using the Cloud Agent.' },
    { id: 'a1', role: 'assistant', text: '', parts: [tool('add_clip', {}, true)], error: 'The model quota has run out', outcome: 'error' },
  ] });
  {
    const st = await A.evaluate(() => ({
      states: [...document.querySelectorAll('[data-pcm="msg-me"] .send-state')].map((e) => e.textContent),
      failed: document.querySelector('[data-pcm="send-failed"]')?.textContent, err: document.querySelector('[data-pcm="msg-error"]')?.textContent,
    }));
    out.V3.states = st;
    check(st.states.length === 2 && st.states[0] === 'Sending…' && st.states[1].startsWith('Sent') && st.failed?.includes('confirm the notice') && st.err === 'The model quota has run out', 'V3 send states (sending / sent / reason it was not sent) and error reason', st);
    await shot('view-chat-states');
  }

  /* ================================================================ V4 quote bar */
  await render({ ...base, quotes: [{ id: 'c-9', label: 'beach-run.mp4' }] });
  await shot('view-quote');
  {
    const bar = (await rects('[data-pcm="refbar"]'))[0], ta = (await rects('[data-pcm="chat-input"]'))[0], chip = (await rects('[data-pcm="ref-chip"]'))[0], x = (await rects('[data-pcm="ref-remove"]'))[0];
    const ph = await A.evaluate(() => document.querySelector('[data-pcm="chat-input"]').placeholder);
    out.V4 = { bar, ta, chip, x, ph };
    check(bar && ta && bar.b <= ta.y + 0.5, 'V4 quote chip bar is above the input box', { bar, ta });
    check(ph === '@Beach run.mp4 how do you want to change it?', 'V4 with a quote, the input placeholder is "@name how do you want to change it?"', ph);
    // Demo is under prototypes/, not in community edition
    if (fs.existsSync(DEMO)) {
      const D = await phone();
      await D.goto(pathToFileURL(DEMO).href, { waitUntil: 'load' });
      await D.evaluate(() => { openProject('p1'); pageAgent(); });
      await sleep(500);
      await D.screenshot({ path: path.join(OUT, 'demo-view-chat.png') });
      await D.evaluate(() => { setRef('beach-run.mp4'); });
      await sleep(300);
      const dr = await D.evaluate(() => { const r = (s) => { const e = document.querySelector(s); const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, b: b.bottom }; }; return { chip: r('.refbar .ref'), x: r('.refbar .ref b'), bar: r('.refbar'), input: r('.in-row input'), composer: r('.composer') }; });
      await D.screenshot({ path: path.join(OUT, 'demo-view-quote.png') });
      out.V4.demo = dr;
      check(near(chip.h, dr.chip.h) && near(x.w, dr.x.w) && near(x.h, dr.x.h) && near(chip.x, dr.chip.x) && near(chip.y, dr.chip.y), 'V4 quote chip size and position match the demo prototype (height, ✕ 18×18, top-left corner)', { mine: chip, demo: dr.chip });
      check(near(bar.y, dr.bar.y) && near(ta.h, dr.input.h) && near(ta.y, dr.input.y), 'V4 chip bar and input box positions match the demo prototype', { mine: { bar, ta }, demo: dr });
      for (const [mine, demo] of [['view-chat', 'view-chat'], ['view-quote', 'view-quote']]) sideBySide(path.join(OUT, `${mine}.png`), path.join(OUT, `demo-${demo}.png`), path.join(OUT, `side-${demo}.png`));
      await D.browserContext().close();
    }
  }

  /* ================================================================ V5 start page */
  const startBase = { ...base, tabs: [{ id: 't0', title: 'Agent 1', draft: true }], activeId: 't0', messages: [], draft: true };
  await render({ ...startBase, animated: true, guide: 'input' });
  await shot('view-start');
  {
    const st = await A.evaluate(() => ({ orb: !!document.querySelector('[data-pcm="agent-start-orb"]'), cue: !!document.querySelector('[data-pcm="agent-start-cue"]'), guide: document.querySelector('[data-pcm="agent-composer"]').getAttribute('data-guide'),
      orbAnim: getComputedStyle(document.querySelector('.orb .core')).animationName, glow: getComputedStyle(document.querySelector('.in-row textarea')).animationName, quicks: !!document.querySelector('[data-pcm="quicks"]') }));
    out.V5.animated = st;
    check(st.orb && st.cue && st.guide === 'input' && st.orbAnim !== 'none' && st.glow !== 'none', 'V5 just entered the project: orb + arrow are animating, input box has a guide outline', st);
    check(!st.quicks, 'V5 no quick prompts on the start page (it has presets)', st);
    const pre = (await rects('[data-pcm="agent-start-preset"]'))[0], box = (await rects('[data-pcm="chat-msgs"]'))[0];
    check(pre && pre.x >= 14 && pre.r <= 375 - 14 && pre.y > box.y && pre.b < box.b, 'V5 preset buttons are inside the message area, not overflowing', { pre, box });
  }
  await render({ ...startBase, animated: true, guide: 'send', inputText: 'Make an animation that tells me what I can do with the software' });
  {
    const st = await A.evaluate(() => ({ guide: document.querySelector('[data-pcm="agent-composer"]').getAttribute('data-guide'), flash: getComputedStyle(document.querySelector('.send')).animationName }));
    check(st.guide === 'send' && st.flash !== 'none', 'V5 after tapping a preset, the send button shows the guide (flashing)', st);
    await shot('view-start-preset');
  }
  await render({ ...startBase, animated: false, guide: null });
  {
    const st = await A.evaluate(() => ({ orb: !!document.querySelector('[data-pcm="agent-start-orb"]'), cue: !!document.querySelector('[data-pcm="agent-start-cue"]'), guide: document.querySelector('[data-pcm="agent-composer"]').getAttribute('data-guide'), preset: !!document.querySelector('[data-pcm="agent-start-preset"]'), input: !!document.querySelector('[data-pcm="chat-input"]'), title: document.querySelector('.start-title')?.textContent }));
    out.V5.cleared = st;
    check(!st.orb && !st.cue && !st.guide && st.preset && st.input && st.title === 'Start', 'V5 after manual clear: no orb or arrow, no guide outline, only the presets and the input box', st);
    await shot('view-start-cleared');
  }
  // Reduce motion: all animations off, only static outline remains
  await A.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await render({ ...startBase, animated: true, guide: 'input' });
  {
    const st = await A.evaluate(() => ({ orbAnim: getComputedStyle(document.querySelector('.orb .core')).animationName, cue: getComputedStyle(document.querySelector('.cue')).animationName, glow: getComputedStyle(document.querySelector('.in-row textarea')).animationName, border: getComputedStyle(document.querySelector('.in-row textarea')).borderColor }));
    out.V5.reduced = st;
    check(st.orbAnim === 'none' && st.cue === 'none' && st.glow === 'none' && st.border === 'rgb(38, 198, 230)', 'V5 with the system set to "Reduce motion": all animations off, only the static outline remains', st);
  }
  await A.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);

  /* ================================================================ V6 Tab row */
  await render({ ...base, tabs: [{ id: 't1', title: 'Agent 1', busy: true }, { id: 't2', title: 'Cut1->Track2 this scope name is very very long long long long long' }, { id: 't3', title: 'Agent 3' }], messages: [] });
  {
    const st = await A.evaluate(() => ({
      tabs: [...document.querySelectorAll('[data-pcm="atab"]')].map((e) => ({ t: e.querySelector('.nm').textContent, x: !!e.querySelector('[data-pcm="atab-close"]'), dot: !!e.querySelector('.dot.run'), w: e.getBoundingClientRect().width, h: e.getBoundingClientRect().height })),
      scrollW: document.querySelector('[data-pcm="atabs"]').scrollWidth, clientW: document.querySelector('[data-pcm="atabs"]').clientWidth, doc: document.documentElement.scrollWidth,
    }));
    out.V6 = st;
    check(st.tabs.length === 3 && st.tabs.every((t) => t.x && t.h === 30), 'V6 every session tab has a ✕, height 30', st.tabs);
    check(st.tabs[0].dot && !st.tabs[1].dot, 'V6 a busy session has a blinking dot', st.tabs);
    check(st.tabs[1].w <= 120 + 4 + 16 + 10 + 4 + 2, 'V6 long title is truncated and does not stretch the width', st.tabs[1]);
    check(st.doc <= 375, 'V6 with too many tabs, only the tab row scrolls horizontally and the page does not stretch', st);
    await shot('view-tabs');
  }
  await render({ ...startBase });
  {
    const st = await A.evaluate(() => [...document.querySelectorAll('[data-pcm="atab"]')].map((e) => ({ t: e.querySelector('.nm').textContent, x: !!e.querySelector('[data-pcm="atab-close"]'), draft: e.dataset.draft })));
    check(st.length === 1 && st[0].t === 'Start' && !st[0].x && st[0].draft === '1', 'V6 with no sessions there is only one item, "Start", and no ✕', st);
  }

  /* ================================================================ V7 Stop button */
  await render({ ...base, streaming: true, inputText: '' });
  {
    const st = await A.evaluate(() => ({ stop: !!document.querySelector('[data-pcm="chat-stop"]'), send: !!document.querySelector('[data-pcm="chat-send"]') }));
    check(st.stop && !st.send, 'V7 while running with an empty input box: the send button becomes the stop button', st);
    await shot('view-stop');
  }
  await render({ ...base, streaming: true, inputText: 'Add one more line' });
  {
    const st = await A.evaluate(() => ({ stop: !!document.querySelector('[data-pcm="chat-stop"]'), send: !!document.querySelector('[data-pcm="chat-send"]') }));
    check(!st.stop && st.send, 'V7 while running with text in the input box: still the send button (queued send)', st);
  }

  /* ================================================================ V8 Overflow and error */
  for (const [label, s] of [['chat', base], ['quote', { ...base, quotes: [{ id: 'c-9', label: 'A very very very very very very very very long media name.mp4' }] }], ['start', { ...startBase, animated: true }]]) {
    await render(s);
    const w = await A.evaluate(() => ({ doc: document.documentElement.scrollWidth, pcm: document.querySelector('.pcm').scrollWidth, vw: innerWidth }));
    out.V8[label] = w;
    check(w.doc <= w.vw && w.pcm <= w.vw, `V8 no horizontal overflow at 375 width (${label})`, w);
  }
  out.V8.pageErrors = A.errors;
  check(A.errors.length === 0, 'V8 no errors on the page', A.errors);
} catch (e) {
  fails.push(`Probe error: ${e?.stack ?? e}`);
} finally {
  out.ok = fails.length === 0;
  out.fails = fails;
  await browser.close().catch(() => {});
  await vite.close().catch(() => {});
  await new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });
  console.log(JSON.stringify(out));
  process.exit(out.ok ? 0 : 1);
}
