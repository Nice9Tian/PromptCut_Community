// First import protects user directories and the shared port file before any fixture import.
import '../lib/no-user-dirs.mjs';
/**
 * Acceptance probe for Vibe mode progress bar glow and drag selection (issue #31).
 *
 * Reuses `src/start/extchat-harness.tsx` (passing `showScrub: true`) under the same real skin and
 * `src/start/start.css` to render the "detail editing" transport bar progress bar
 * (`[data-pc="start-detail-scrub"]`) and the right side panel "Video" mini-window progress bar
 * (`[data-pc="start-ext-scrub"]`), tested with a headless browser with `--enable-caret-browsing`:
 *
 *   node scripts/probes/vibe-scrub-probe.mjs [--out <screenshot-dir>] [--port 5953]
 *   Port: 5950-5959 assigned to this probe
 *
 * Acceptance (each item adds a line to `fails` in the final JSON line):
 *   V1 Neither progress bar has a rectangular `box-shadow` or `outline` under `:hover`, `:focus`,
 *      or `:focus-visible` (`boxShadow === "none"`, `outlineStyle === "none"`), glowing along the
 *      track and thumb contours via `filter: drop-shadow(...)` instead.
 *   V2 Pixel sampling check: when the progress bar glows on focus/hover, 2px outside the top and
 *      bottom of the track (still within the `<input>` 16px rectangular box) is brighter than the
 *      far background, no longer cutting off the glow into a rectangular dark groove with a black
 *      border.
 *   V3 Transport bar and sliders (`.ps-detail-head`, `.ps-detail-stage`, `.ps-detail-transport`,
 *      `.ps-stage-over`, `.ps-ext-transport`, `.ps-card-head`, `.ps-detail-scrub`,
 *      `.ps-ext-scrub`) are all `user-select: none`, and both sliders are
 *      `caret-color: transparent`.
 *   V4 Dragging both progress bars with `--enable-caret-browsing` enabled, as well as dragging from
 *      the 4px transport bar whitespace above the slider across time text, headers, and chat
 *      bubbles: existing page selection is cleared immediately, throughout
 *      `getSelection().type === "None"` and `getSelection().toString() === ""`, slider values
 *      update normally with dragging, and no vertical caret appears to the left of the thumb.
 *   V5 Static check of `src/start/DetailEdit.tsx` and `src/start/ChatSidePanel.tsx`: both progress
 *      sliders clear page selection in `onPointerDown`.
 * Screenshots: `scrub-detail-focus.png`, `scrub-ext-hover.png`, `scrub-after-drag.png`. The last
 * line outputs JSON: { ok, fails, ... }.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import puppeteer from 'puppeteer';
import { createServer as createViteServer } from 'vite';
import react from '@vitejs/plugin-react';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';

setTimeout(() => { console.error('SCRIPT_TIMEOUT'); process.exit(124); }, 5 * 60_000).unref();

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), 'vibe-scrub-shots')));
const PORT = Number(arg('--port', 5953));
if (PORT < 5950 || PORT > 5959) throw new Error(`Port ${PORT} is not within 5950-5959, the range assigned to this probe`);
fs.mkdirSync(OUT, { recursive: true });

const fails = [];
const out = { ok: false, out: OUT, V1: {}, V2: {}, V3: {}, V4: {}, V5: {} };
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 500))); return !!cond; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const portOpen = (port) => new Promise((resolve) => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); resolve(true); }); s.once('error', () => resolve(false)); });
if (await portOpen(PORT)) throw new Error(`Port ${PORT} is already in use`);

/* ================================================================ V5 Source code static check */
{
  const detailSrc = fs.readFileSync(path.join(ROOT, 'src/start/DetailEdit.tsx'), 'utf8');
  const extSrc = fs.readFileSync(path.join(ROOT, 'src/start/ChatSidePanel.tsx'), 'utf8');
  const detailHasClear = /start-detail-scrub[\s\S]{0,240}onPointerDown=\{[^}]*getSelection\(\)\?\.removeAllRanges\(\)/.test(detailSrc);
  const extHasClear = /start-ext-scrub[\s\S]{0,240}onPointerDown=\{[^}]*getSelection\(\)\?\.removeAllRanges\(\)/.test(extSrc);
  out.V5 = { detailHasClear, extHasClear };
  check(detailHasClear, 'V5 the progress slider in DetailEdit.tsx clears the selection on onPointerDown', out.V5);
  check(extHasClear, 'V5 the progress slider in ChatSidePanel.tsx clears the selection on onPointerDown', out.V5);
}

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

const now = Date.now();
const tool = (name, input = {}, ok) => ({ kind: 'tool', name: `mcp__promptcut__${name}`, input, ...(ok === undefined ? {} : { ok }) });
const say = (text) => tool('send_message', { to: 'user', text }, true);
const MSGS = [
  { id: 'u1', role: 'user', text: 'Speed up the opening pacing a bit, and make the shot push-in crisper.' },
  { id: 'a1', role: 'assistant', text: '', startedAt: now, finishedAt: now, outcome: 'completed', parts: [
    say('I moved the switch between the first two segments 0.8 s earlier. Drag the progress bar to see whether the beat points feel smooth.'),
    tool('set_clip_param', { id: 'c1' }, true),
  ] },
];

const browser = await puppeteer.launch({
  headless: true,
  ignoreDefaultArgs: ['--hide-scrollbars'],
  protocolTimeout: 300_000,
  args: [...PROBE_CHROME_ARGS, '--no-first-run', '--enable-caret-browsing'],
});

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e?.message ?? e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console:${m.text()}`); });
  await page.setViewport({ width: 1280, height: 760, deviceScaleFactor: 2 });
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__extChatHarness, { timeout: 120_000 });
  await page.evaluate((st) => window.__extChatHarness.render(st), {
    messages: MSGS,
    width: 340,
    canSend: true,
    whyNot: null,
    showScrub: true,
  });
  await sleep(450);

  /* ================================================================ V1 & V3 Style check */
  await page.focus('[data-pc="start-detail-scrub"]');
  await page.hover('[data-pc="start-ext-scrub"]');
  await sleep(100);

  const styleInfo = await page.evaluate(() => {
    const pick = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        boxShadow: cs.boxShadow,
        outlineStyle: cs.outlineStyle,
        filter: cs.filter,
        userSelect: cs.userSelect,
        caretColor: cs.caretColor,
      };
    };
    return {
      detailScrub: pick('[data-pc="start-detail-scrub"]'),
      extScrub: pick('[data-pc="start-ext-scrub"]'),
      detailHead: pick('.ps-detail-head'),
      detailStage: pick('.ps-detail-stage'),
      detailTransport: pick('.ps-detail-transport'),
      stageOver: pick('.ps-stage-over'),
      extTransport: pick('.ps-ext-transport'),
      cardHead: pick('.ps-card-head'),
    };
  });

  out.V1 = { detailScrub: styleInfo.detailScrub, extScrub: styleInfo.extScrub };
  check(styleInfo.detailScrub?.boxShadow === 'none' && styleInfo.detailScrub?.outlineStyle === 'none', 'V1 the detail editing progress bar has no rectangular box-shadow or outline', styleInfo.detailScrub);
  check(styleInfo.detailScrub?.filter?.includes('drop-shadow('), 'V1 the detail editing progress bar uses drop-shadow to glow along the track', styleInfo.detailScrub);
  check(styleInfo.extScrub?.boxShadow === 'none' && styleInfo.extScrub?.outlineStyle === 'none', 'V1 the mini window progress bar has no rectangular box-shadow or outline', styleInfo.extScrub);
  check(styleInfo.extScrub?.filter?.includes('drop-shadow('), 'V1 the mini window progress bar uses drop-shadow to glow along the track', styleInfo.extScrub);

  out.V3 = styleInfo;
  for (const [k, v] of Object.entries(styleInfo)) {
    check(v?.userSelect === 'none', `V3 ${k} has user-select: none set`, v);
  }
  check(styleInfo.detailScrub?.caretColor === 'rgba(0, 0, 0, 0)', 'V3 the detail editing progress bar\'s caret-color is transparent', styleInfo.detailScrub);
  check(styleInfo.extScrub?.caretColor === 'rgba(0, 0, 0, 0)', 'V3 the mini window progress bar\'s caret-color is transparent', styleInfo.extScrub);

  /* ================================================================ V2 Pixel check (glow not cut off into rectangular box) */
  const detailShotPath = path.join(OUT, 'scrub-detail-focus.png');
  const detailClip = await page.$eval('.ps-detail-transport', (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.max(0, Math.floor(r.x)), y: Math.max(0, Math.floor(r.y)), width: Math.ceil(r.width), height: Math.ceil(r.height) };
  });
  await page.screenshot({ path: detailShotPath, clip: detailClip });

  const extShotPath = path.join(OUT, 'scrub-ext-hover.png');
  const extClip = await page.$eval('[data-pc="start-ext-stage"]', (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.max(0, Math.floor(r.x)), y: Math.max(0, Math.floor(r.y)), width: Math.ceil(r.width), height: Math.ceil(r.height) };
  });
  await page.screenshot({ path: extShotPath, clip: extClip });

  // Measure luminance distribution directly above the filled segment of the detail editing
  // progress bar (left accent color track):
  // Track height 8px, `<input>` box height 16px. The old `box-shadow` left a black border 4-7px from
  // the center, glowing only beyond 8px;
  // after switching to `drop-shadow`, a glow transition appears 5-6px from the track center (still
  // within the `<input>` box), brighter than the far background and decaying monotonically outward.
  const detailBox = await page.$eval('[data-pc="start-detail-scrub"]', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  const png = PNG.sync.read(fs.readFileSync(detailShotPath));
  const dpr = 2;
  const sampleX = Math.round((detailBox.x - detailClip.x + detailBox.width * 0.15) * dpr);
  const centerY = Math.round((detailBox.y - detailClip.y + detailBox.height * 0.5) * dpr);
  const lumAt = (px, py) => {
    const idx = (py * png.width + px) * 4;
    return Math.round((png.data[idx] * 0.2126 + png.data[idx + 1] * 0.7152 + png.data[idx + 2] * 0.0722) * 10) / 10;
  };
  // dyCss = 6px is still within the `<input>` 16px box (2px directly above the 8px track),
  // dyCss = 10px is outside the `<input>` box, and dyCss = 16px is the far background
  const lumNearTrack = lumAt(sampleX, centerY - 6 * dpr);
  const lumMidGlow = lumAt(sampleX, centerY - 10 * dpr);
  const lumFarBg = lumAt(sampleX, centerY - 16 * dpr);
  out.V2 = { lumNearTrack, lumMidGlow, lumFarBg };
  check(lumNearTrack > lumFarBg + 3, 'V2 outside the track (inside the <input> box) there is a real glow, not a clipped-out black box', out.V2);
  check(lumNearTrack >= lumMidGlow && lumMidGlow >= lumFarBg, 'V2 the glow fades smoothly outward from the track, with no jump at a rectangular boundary', out.V2);

  /* ================================================================ V4 Dragging and selection check */
  // 1) Intentionally select a section of chat text first, then press and drag the detail editing
  // progress bar: the old selection should be cleared immediately, with no selection after dragging
  await page.evaluate(() => {
    const msg = document.querySelector('.ps-xtext');
    if (msg) {
      const range = document.createRange();
      range.selectNodeContents(msg);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  });
  const preSel = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  await page.mouse.move(detailBox.x + detailBox.width * 0.2, detailBox.y + detailBox.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(detailBox.x + detailBox.width * 0.65, detailBox.y + detailBox.height * 0.5, { steps: 12 });
  await page.mouse.up();
  const afterDetailDrag = await page.evaluate(() => ({
    selType: window.getSelection()?.type ?? 'None',
    selText: window.getSelection()?.toString() ?? '',
    value: Number(document.querySelector('[data-pc="start-detail-scrub"]').value),
  }));

  // 2) Press 4px above the detail editing progress bar (transport bar whitespace) and drag all the
  // way across the right time text and top bar header: no content selection should be triggered
  await page.mouse.move(detailBox.x + 40, detailBox.y - 4);
  await page.mouse.down();
  await page.mouse.move(detailBox.x + detailBox.width + 80, detailBox.y + 8, { steps: 10 });
  await page.mouse.move(detailBox.x + 120, 24, { steps: 10 });
  await page.mouse.up();
  const afterDetailMissDrag = await page.evaluate(() => ({
    selType: window.getSelection()?.type ?? 'None',
    selText: window.getSelection()?.toString() ?? '',
  }));

  // 3) Drag the mini-window progress bar, and drag from the mini-window transport bar whitespace
  // toward the chat panel below: likewise triggers no selection, and slider value changes normally
  const extBox = await page.$eval('[data-pc="start-ext-scrub"]', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  await page.mouse.move(extBox.x + extBox.width * 0.2, extBox.y + extBox.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(extBox.x + extBox.width * 0.75, extBox.y + extBox.height * 0.5, { steps: 12 });
  await page.mouse.up();
  const afterExtDrag = await page.evaluate(() => ({
    selType: window.getSelection()?.type ?? 'None',
    selText: window.getSelection()?.toString() ?? '',
    value: Number(document.querySelector('[data-pc="start-ext-scrub"]').value),
  }));

  await page.mouse.move(extBox.x + 20, extBox.y - 4);
  await page.mouse.down();
  await page.mouse.move(extBox.x + extBox.width + 50, extBox.y + 180, { steps: 12 });
  await page.mouse.up();
  const afterExtMissDrag = await page.evaluate(() => ({
    selType: window.getSelection()?.type ?? 'None',
    selText: window.getSelection()?.toString() ?? '',
  }));

  await page.screenshot({ path: path.join(OUT, 'scrub-after-drag.png') });

  out.V4 = { preSelLen: preSel.length, afterDetailDrag, afterDetailMissDrag, afterExtDrag, afterExtMissDrag, errors };
  check(preSel.length > 0, 'V4 create a non-empty selection before dragging, for comparison', out.V4);
  check(afterDetailDrag.selType === 'None' && afterDetailDrag.selText === '', 'V4 after pressing and dragging the detail editing progress bar, the selection is cleared and no vertical-line caret is left', afterDetailDrag);
  check(afterDetailDrag.value > 30, 'V4 the progress value updates after dragging the detail editing progress bar', afterDetailDrag);
  check(afterDetailMissDrag.selType === 'None' && afterDetailMissDrag.selText === '', 'V4 dragging across the time and title from the blank area of the detail editing transport bar does not unexpectedly select content', afterDetailMissDrag);
  check(afterExtDrag.selType === 'None' && afterExtDrag.selText === '', 'V4 dragging the mini window progress bar produces no selection or vertical-line caret', afterExtDrag);
  check(afterExtDrag.value > 35, 'V4 the progress value updates after dragging the mini window progress bar', afterExtDrag);
  check(afterExtMissDrag.selType === 'None' && afterExtMissDrag.selText === '', 'V4 dragging from the blank area of the mini window transport bar down to the chat area does not unexpectedly select content', afterExtMissDrag);
  check(errors.length === 0, 'V4 the page has no errors', errors.slice(0, 3));
} finally {
  await browser.close().catch(() => {});
  await new Promise((r) => server.close(r));
  await vite.close().catch(() => {});
}

out.ok = fails.length === 0;
out.fails = fails;
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
