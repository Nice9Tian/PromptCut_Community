// First import protects user directories and the shared port file before any fixture import.
import '../lib/no-user-dirs.mjs';
/**
 * 氛围式「详细编辑」展开时，拓展栏里那块聊天面板怎么画的验收探针（issue #4，用户 2026-10-26 定）。
 *
 * 不接云端、不接项目、不挂真舞台：`src/start/extchat-harness.tsx` 用探针给的假消息把那条拓展栏单独画出来，
 * vite 中间件模式服务它（写法同 `mobile-agent-view-probe.mjs`）。
 *
 *   node scripts/probes/vibe-ext-chat-probe.mjs [--out <截图目录>] [--port 5952]
 *   端口：分给本探针的 5950～5959
 *
 * 验收（每项一行进最后那行 JSON 的 `fails`）：
 *   V1 只有**最新那一条 Agent 回复**留全文；其余 Agent 回复和全部用户气泡都收起来（`data-folded`）；
 *      全文那条上方标「最新一条回复」。
 *   V2 收起来的文字正好两行：气泡里那段话的可见高度 ≈ 2 行，且确实被截掉了一截。
 *   V3 收起来的那一轮「Agent 操作」整块折起来，另标一句「… 还有 N 条操作」，N 和这一轮的操作条数一致。
 *   V4 点一下收起来的气泡，只有它展开（`data-folded` 没了、操作卡出来），别的仍然收着。
 *   V5 「甲」：上面两段照常摊开，聊天面板吃掉这条栏剩下的高度（底边贴着栏的下内边距），
 *      输入框钉在面板自己的底部、就在面板里面。
 *   V6 一行说完的短句不摆出能点开的样子：收着（`data-folded`）但没有 `data-more`。
 *   V7 最窄 250px（`sideWidth.ts` 的 `EXT_WIDTH.min`）时不横向溢出、页面无报错。
 * 截图：`ext-chat-<宽度>.png`、`ext-chat-expanded.png`。最后一行是一行 JSON：{ ok, fails, ... }。退出码 0 过、1 不过。
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
if (PORT < 5950 || PORT > 5959) throw new Error(`端口 ${PORT} 不在分给本探针的 5950～5959 里`);
fs.mkdirSync(OUT, { recursive: true });

const fails = [];
const out = { ok: false, out: OUT, V1: {}, V2: {}, V3: {}, V4: {}, V5: {}, V6: {}, V7: {} };
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 500))); return !!cond; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const portOpen = (port) => new Promise((resolve) => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); resolve(true); }); s.once('error', () => resolve(false)); });
if (await portOpen(PORT)) throw new Error(`端口 ${PORT} 已被占用`);

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

/* ── 假消息:两轮带操作的回复,中间夹用户的话,最后一条用户消息只有一行 ── */
const now = Date.now();
const tool = (name, input = {}, ok) => ({ kind: 'tool', name: `mcp__promptcut__${name}`, input, ...(ok === undefined ? {} : { ok }) });
const say = (text) => tool('send_message', { to: 'user', text }, true);
const MSGS = [
  { id: 'u1', role: 'user', text: '用代码做一支60秒一镜到底动画：桌上一张户型图照片>扫描拉正>墙从线里长出来、门窗家具落位镜头穿过阳台门进客厅，画面用路径追踪从噪点收敛成照片级>依次按照户型解说。' },
  { id: 'a1', role: 'assistant', text: '', startedAt: now, finishedAt: now, outcome: 'completed', parts: [
    say('好的。我先把这支片子拆成 6 段：桌面静物、扫描拉正、墙体生长、门窗家具落位、穿门入厅、路径追踪收敛。先把项目建起来，前两段的卡片也一并排好，你看一眼节奏对不对。'),
    tool('add_clip', { name: '户型图照片' }, true),
    tool('add_clip', { name: '扫描拉正' }, true),
  ] },
  { id: 'u2', role: 'user', text: '慢一点' },
  { id: 'a2', role: 'assistant', text: '', startedAt: now, finishedAt: now, outcome: 'completed', parts: [
    say('已经把「墙体生长」从 5 秒拉到 8 秒，后面几段顺延。现在整支是 62 秒，要不要把最后那段解说压到 6 秒、收回 60 秒整？'),
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

  /** 面板里每一条消息此刻长什么样 */
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

  /* ================================================================ V1~V3、V6 */
  await render({ ...base, width: 320 });
  await shot('ext-chat-320');
  {
    const rows = await readRows();
    out.V1 = rows.map((r) => ({ from: r.from, folded: r.folded, more: r.more, head: r.head }));
    check(rows.length === 4, 'V1 四条消息都画出来了', rows.length);
    check(rows.slice(0, 3).every((r) => r.folded === true), 'V1 旧的 Agent 回复和用户气泡都收起来了', rows.map((r) => r.folded));
    check(rows[3]?.folded === false || rows[3]?.folded === null, 'V1 最新那一条 Agent 回复留全文', rows[3]);
    const latestTag = await page.$eval('.ps-xlatest', (e) => e.textContent).catch(() => null);
    check(latestTag === '最新一条回复', 'V1 全文那条上方标「最新一条回复」', latestTag);

    const long = rows[0];
    out.V2 = long;
    check(long.textH !== null && long.lineH !== null && Math.abs(long.textH - long.lineH * 2) <= 2, 'V2 收起来的文字正好两行', long);
    check(long.scrollH - long.textH > 2, 'V2 确实被截掉了一截(不是刚好两行)', long);

    const foldedAgent = rows[1];
    out.V3 = foldedAgent;
    check(foldedAgent.from === 'agent' && !foldedAgent.opsVisible, 'V3 收起来的那一轮「Agent 操作」折起来了', foldedAgent);
    check(foldedAgent.more_text === `… 还有 ${foldedAgent.opsCount} 条操作` && foldedAgent.opsCount === 2, 'V3 标了还有几条操作、条数对得上', foldedAgent);
    check(rows[3].opsVisible === true, 'V3 最新那条的操作照常显示', rows[3]);

    const short = rows[2];
    out.V6 = short;
    check(short.folded === true && short.more === false, 'V6 一行说完的短句收着但不摆出能点开的样子', short);
    check(short.cursor !== 'zoom-in', 'V6 短句上没有 zoom-in 光标', short);
    check(rows[0].more === true && rows[0].cursor === 'zoom-in', 'V6 真被截到的那条才给 zoom-in', rows[0]);
  }

  /* ================================================================ V4 点开一条 */
  {
    await page.evaluate(() => document.querySelectorAll('[data-pc="start-ext-chat-msg"]')[1].querySelector('.ps-xbody').click());
    await sleep(300);
    await shot('ext-chat-expanded');
    const rows = await readRows();
    out.V4 = rows.map((r) => ({ from: r.from, folded: r.folded, opsVisible: r.opsVisible }));
    check(rows[1].folded === false, 'V4 点过的那条展开了', rows[1]);
    check(rows[1].opsVisible === true, 'V4 展开之后操作卡出来了', rows[1]);
    check(rows[0].folded === true && rows[2].folded === true, 'V4 别的仍然收着', out.V4);
  }

  /* ================================================================ V5 高度分配(「甲」) */
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
    check(box.secs.length === 2 && box.secs.every((s) => s.bodyShown && s.h > 40), 'V5 上面两段照常摊开', box.secs);
    check(Math.abs(box.chat.bottom - (box.ext.bottom - box.pad)) <= 1, 'V5 聊天面板吃掉剩下的高度,底边贴着栏的下内边距', box);
    check(box.chat.h > box.secs[0].h, 'V5 聊天面板比上面那一段高', box);
    check(box.foot.bottom <= box.chat.bottom && box.foot.top >= box.list.bottom - 1, 'V5 输入框钉在面板自己的底部、就在面板里面', box);
  }

  /* ================================================================ V7 最窄 250 */
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
    check(narrow.extW === 250, 'V7 这条栏就是 250 宽', narrow);
    check(narrow.overflowX <= 0 && narrow.listOverflowX <= 0, 'V7 250 宽下不横向溢出', narrow);
    check(errors.length === 0, 'V7 页面没有报错', errors.slice(0, 3));
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
