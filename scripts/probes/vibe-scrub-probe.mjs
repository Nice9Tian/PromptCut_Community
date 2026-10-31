// First import protects user directories and the shared port file before any fixture import.
import '../lib/no-user-dirs.mjs';
/**
 * 氛围式进度条发光与拖动选区验收探针（issue #31）。
 *
 * 复用 `src/start/extchat-harness.tsx`（传 `showScrub: true`），在同一套真实皮肤与 `src/start/start.css` 下
 * 把「详细编辑」传输栏进度条（`[data-pc="start-detail-scrub"]`）与右侧拓展栏「画面」小窗进度条
 * （`[data-pc="start-ext-scrub"]`）画出来，并用带 `--enable-caret-browsing` 的无头浏览器实测：
 *
 *   node scripts/probes/vibe-scrub-probe.mjs [--out <截图目录>] [--port 5953]
 *   端口：分给本探针的 5950～5959
 *
 * 验收（每项一行进最后那行 JSON 的 `fails`）：
 *   V1 两条进度条在 `:hover`、`:focus`、`:focus-visible` 下都不挂矩形 `box-shadow` 与 `outline`
 *      （`boxShadow === "none"`、`outlineStyle === "none"`），改由 `filter: drop-shadow(...)` 顺着轨道和圆钮轮廓发光。
 *   V2 像素抽样核对：进度条聚焦/悬停发光时，轨道上下外侧 2px（仍在 `<input>` 16px 矩形盒内）比远端背景亮，
 *      不再出现把发光截断成一圈黑框的矩形暗槽。
 *   V3 传输栏与滑杆（`.ps-detail-head`、`.ps-detail-stage`、`.ps-detail-transport`、`.ps-stage-over`、
 *      `.ps-ext-transport`、`.ps-card-head`、`.ps-detail-scrub`、`.ps-ext-scrub`）均为 `user-select: none`，
 *      两条滑杆均为 `caret-color: transparent`。
 *   V4 开启 `--enable-caret-browsing` 拖动两条进度条，以及从滑杆上方 4px 的传输栏留白起拖横穿时间文字、标题和聊天气泡：
 *      原有的页面选区被立刻清掉，全程 `getSelection().type === "None"`、`getSelection().toString() === ""`，
 *      滑杆数值正常随拖动更新，圆钮左侧不出现竖线光标。
 *   V5 静态核对 `src/start/DetailEdit.tsx` 与 `src/start/ChatSidePanel.tsx`：两处进度滑杆都在 `onPointerDown` 清掉页面选区。
 * 截图：`scrub-detail-focus.png`、`scrub-ext-hover.png`、`scrub-after-drag.png`。最后一行输出 JSON：{ ok, fails, ... }。
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
if (PORT < 5950 || PORT > 5959) throw new Error(`端口 ${PORT} 不在分给本探针的 5950～5959 里`);
fs.mkdirSync(OUT, { recursive: true });

const fails = [];
const out = { ok: false, out: OUT, V1: {}, V2: {}, V3: {}, V4: {}, V5: {} };
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 500))); return !!cond; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const portOpen = (port) => new Promise((resolve) => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); resolve(true); }); s.once('error', () => resolve(false)); });
if (await portOpen(PORT)) throw new Error(`端口 ${PORT} 已被占用`);

/* ================================================================ V5 源码静态核对 */
{
  const detailSrc = fs.readFileSync(path.join(ROOT, 'src/start/DetailEdit.tsx'), 'utf8');
  const extSrc = fs.readFileSync(path.join(ROOT, 'src/start/ChatSidePanel.tsx'), 'utf8');
  const detailHasClear = /start-detail-scrub[\s\S]{0,240}onPointerDown=\{[^}]*getSelection\(\)\?\.removeAllRanges\(\)/.test(detailSrc);
  const extHasClear = /start-ext-scrub[\s\S]{0,240}onPointerDown=\{[^}]*getSelection\(\)\?\.removeAllRanges\(\)/.test(extSrc);
  out.V5 = { detailHasClear, extHasClear };
  check(detailHasClear, 'V5 DetailEdit.tsx 的进度滑杆在 onPointerDown 清掉选区', out.V5);
  check(extHasClear, 'V5 ChatSidePanel.tsx 的进度滑杆在 onPointerDown 清掉选区', out.V5);
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
  { id: 'u1', role: 'user', text: '把开场节奏调快一点，让镜头推进更干脆。' },
  { id: 'a1', role: 'assistant', text: '', startedAt: now, finishedAt: now, outcome: 'completed', parts: [
    say('已经把前两段的切换提前了 0.8 秒，你拖一下进度条看看卡点顺不顺。'),
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

  /* ================================================================ V1 & V3 样式核对 */
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
  check(styleInfo.detailScrub?.boxShadow === 'none' && styleInfo.detailScrub?.outlineStyle === 'none', 'V1 详细编辑进度条无矩形 box-shadow 与 outline', styleInfo.detailScrub);
  check(styleInfo.detailScrub?.filter?.includes('drop-shadow('), 'V1 详细编辑进度条用 drop-shadow 顺着轨道发光', styleInfo.detailScrub);
  check(styleInfo.extScrub?.boxShadow === 'none' && styleInfo.extScrub?.outlineStyle === 'none', 'V1 小窗进度条无矩形 box-shadow 与 outline', styleInfo.extScrub);
  check(styleInfo.extScrub?.filter?.includes('drop-shadow('), 'V1 小窗进度条用 drop-shadow 顺着轨道发光', styleInfo.extScrub);

  out.V3 = styleInfo;
  for (const [k, v] of Object.entries(styleInfo)) {
    check(v?.userSelect === 'none', `V3 ${k} 已设 user-select: none`, v);
  }
  check(styleInfo.detailScrub?.caretColor === 'rgba(0, 0, 0, 0)', 'V3 详细编辑进度条 caret-color 为透明', styleInfo.detailScrub);
  check(styleInfo.extScrub?.caretColor === 'rgba(0, 0, 0, 0)', 'V3 小窗进度条 caret-color 为透明', styleInfo.extScrub);

  /* ================================================================ V2 像素核对(发光不截断成矩形框) */
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

  // 在详细编辑进度条已填充段(左侧强调色轨道)正上方量亮度分布:
  // 轨道高 8px、`<input>` 盒高 16px。旧的 `box-shadow` 会在距中心 4~7px 处留出黑框、8px 外才亮;
  // 改成 `drop-shadow` 后,距轨道中心 5~6px(仍在 `<input>` 盒内)就有发光过渡,比远端背景亮且向远端单调衰减。
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
  // dyCss = 6px 仍在 `<input>` 16px 盒内(紧贴 8px 轨道上方 2px),dyCss = 10px 在 `<input>` 盒外,dyCss = 16px 是远端背景
  const lumNearTrack = lumAt(sampleX, centerY - 6 * dpr);
  const lumMidGlow = lumAt(sampleX, centerY - 10 * dpr);
  const lumFarBg = lumAt(sampleX, centerY - 16 * dpr);
  out.V2 = { lumNearTrack, lumMidGlow, lumFarBg };
  check(lumNearTrack > lumFarBg + 3, 'V2 轨道外侧 (<input> 盒内) 有真实发光而非被裁空的黑框', out.V2);
  check(lumNearTrack >= lumMidGlow && lumMidGlow >= lumFarBg, 'V2 发光从轨道向外平滑衰减、没有矩形边界跳变', out.V2);

  /* ================================================================ V4 拖动与选区核对 */
  // 1) 先故意全选一段聊天文字,再按下并拖动详细编辑进度条:旧选区应立刻被清掉,且拖动后无选区
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

  // 2) 从详细编辑进度条上方 4px(传输栏留白处)按下并一路拖过右侧时间文字和顶栏标题:不应触发任何内容选中
  await page.mouse.move(detailBox.x + 40, detailBox.y - 4);
  await page.mouse.down();
  await page.mouse.move(detailBox.x + detailBox.width + 80, detailBox.y + 8, { steps: 10 });
  await page.mouse.move(detailBox.x + 120, 24, { steps: 10 });
  await page.mouse.up();
  const afterDetailMissDrag = await page.evaluate(() => ({
    selType: window.getSelection()?.type ?? 'None',
    selText: window.getSelection()?.toString() ?? '',
  }));

  // 3) 拖动小窗进度条,并从小窗传输栏留白拖向下面的聊天面板:同样不触发任何选中,且滑杆值正常改变
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
  check(preSel.length > 0, 'V4 拖动前先造出一条非空选区供对照', out.V4);
  check(afterDetailDrag.selType === 'None' && afterDetailDrag.selText === '', 'V4 按下拖动详细编辑进度条后选区被清空、不留竖线光标', afterDetailDrag);
  check(afterDetailDrag.value > 30, 'V4 拖动详细编辑进度条后进度值更新', afterDetailDrag);
  check(afterDetailMissDrag.selType === 'None' && afterDetailMissDrag.selText === '', 'V4 从详细编辑传输栏留白拖过时间与标题不意外选中内容', afterDetailMissDrag);
  check(afterExtDrag.selType === 'None' && afterExtDrag.selText === '', 'V4 拖动小窗进度条不产生选区与竖线光标', afterExtDrag);
  check(afterExtDrag.value > 35, 'V4 拖动小窗进度条后进度值更新', afterExtDrag);
  check(afterExtMissDrag.selType === 'None' && afterExtMissDrag.selText === '', 'V4 从小窗传输栏留白拖向下方聊天区不意外选中内容', afterExtMissDrag);
  check(errors.length === 0, 'V4 页面无报错', errors.slice(0, 3));
} finally {
  await browser.close().catch(() => {});
  await new Promise((r) => server.close(r));
  await vite.close().catch(() => {});
}

out.ok = fails.length === 0;
out.fails = fails;
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
