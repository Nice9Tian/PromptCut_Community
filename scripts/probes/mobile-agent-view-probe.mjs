/**
 * 手机版 Agent 分页「对话页怎么画」的验收探针(配合 `mobile-agent-probe.mjs`:那支在真页面上测开始页、引用、标签,这支用假消息测对话页的画法)。
 * 不接云端、不接项目:`src/mobile/agent-harness.tsx` 把对话页(`AgentChatView`)和标签行单独画出来,vite 中间件模式服务它;
 * 同尺寸(375×812、触屏)打开演示稿 `prototypes/mobile-ui-demo/` 的 Agent 页并排对照。
 *
 *   node scripts/probes/mobile-agent-view-probe.mjs [--out <截图目录>] [--port 5985]
 *
 * 验收(每项一行进最后那行 JSON 的 `fails`):
 *   V1 我的气泡靠右、Agent 的气泡靠左、气泡最宽 88%;消息开头的引用画成标记(「@ 名字」),只读、没有 ✕;
 *   V2 操作卡片:「Agent 操作」标签 + 「第 N 轮 · M 项操作」,最新一轮与在跑的一轮默认展开、旧的一轮折叠,点标题能折起 / 展开;
 *      条目状态:完成(绿)、失败(红)、在做(青蓝在闪)、还没做(灰);小结的已完成 / 待办 / 问题变成卡片里的行;
 *   V3 还在跑的一轮末尾有三点「正在做什么」;出错的一轮显示原因;云端还没收下的消息显示发送状态;
 *   V4 引用标记条:在输入框上方、底边 ≤ 输入框顶边,尺寸同演示稿(标记高、✕ 18×18);带引用时输入框的提示是「@名字 想怎么改?」;
 *   V5 开始页:刚进项目有光点 + 箭头(减少动态效果时动画关掉),输入框带引导描边;点预设后发送钮带引导;手动清空后没有光点和箭头;
 *   V6 对话标签行:每个会话标签都有 ✕;忙着的会话有闪动的小点;长标题被截断不撑宽;没有会话时只有一项「开始」没有 ✕;
 *   V7 发送钮:在跑且输入框空时换成停止钮;
 *   V8 375 宽无横向溢出,没有页面报错。
 * 截图:`view-*.png`,与演示稿并排的 `side-view-*.png`。结果最后一行是一行 JSON(`ok`、`fails`、各项数字)。
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer';
import { createServer as createViteServer } from 'vite';
// 这台 vite 不走 vite.config.ts，别名要自己挂（漏了的话浏览器侧 transform 500，页面打不开）
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
if (PORT < 5980 || PORT > 5989) throw new Error(`端口 ${PORT} 不在分给本探针的 5980～5989 里`);
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
if (await portOpen(PORT)) throw new Error(`端口 ${PORT} 已被占用`);

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
  { id: 'u1', role: 'user', text: '给开头加个标题,要有夏天的感觉,然后配点轻松的音乐' },
  { id: 'a1', role: 'assistant', text: '', startedAt: now, finishedAt: now, outcome: 'completed', parts: [
    say('好的,我先看了一下前 6 秒的画面,打算用大号手写感标题 + 暖色调。马上做。'),
    tool('list_media', {}, true), tool('add_clip', {}, true), tool('set_clip_param', {}, false), tool('see_frames', {}, true),
    tool('report_progress', { final: true, done: ['新建文字动效卡「夏日海边」'], todo: ['检查音乐与字幕是否冲突'], problems: ['字体缺失,先用了默认字体'] }, true),
    say('标题和音乐都放好了。你可以直接在预览里拖动标题,或者告诉我想怎么改。'),
  ] },
  { id: 'u2', role: 'user', text: '@卡片 沙滩奔跑.mp4(c-9) 把这段剪短一点' },
  { id: 'a2', role: 'assistant', text: '', startedAt: now, pending: true, progress: { phase: 'run', text: '正在读取当前时间轴与你引用的片段' }, parts: [tool('get_project', {}, true), tool('split_clip', {})] },
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

  /* ================================================================ V1~V3 对话 */
  await render({ ...base, messages: MSGS });
  await shot('view-chat');
  {
    const box = (await rects('[data-pcm="chat-msgs"]'))[0];
    const me = await rects('[data-pcm="msg-me"]'), ag = await rects('[data-pcm="msg-ag"]');
    out.V1 = { box, me, ag: ag.slice(0, 3) };
    check(me.length === 2 && me.every((m) => near(m.r, box.r - 14, 2) && m.w <= box.w * 0.88 + 30), 'V1 我的气泡靠右、最宽 88%', { me, box });
    check(ag.length >= 2 && ag.every((m) => near(m.x, box.x + 14, 2) && m.w <= box.w * 0.88 + 30), 'V1 Agent 的气泡靠左、最宽 88%', { ag, box });
    const refs = await A.evaluate(() => [...document.querySelectorAll('[data-pcm="msg-me"] [data-pcm="ref-tag"]')].map((e) => ({ t: e.textContent.trim(), x: !!e.querySelector('b') })));
    check(refs.length === 1 && refs[0].t === '@ 沙滩奔跑.mp4' && !refs[0].x, 'V1 消息开头的引用画成只读标记(没有 ✕)', refs);
    const mine = await A.evaluate(() => [...document.querySelectorAll('[data-pcm="msg-me"]')].map((e) => e.querySelector('.plain')?.textContent));
    check(mine[1] === '把这段剪短一点', 'V1 引用串从正文里拿掉了', mine);
    const who = await A.evaluate(() => [...document.querySelectorAll('[data-pcm="msg-ag"] .who')].map((e) => e.textContent));
    check(who.length >= 2 && who.every((w) => w === 'Agent 1'), 'V1 Agent 气泡上标是哪个会话', who);

    const cards = await A.evaluate(() => [...document.querySelectorAll('[data-pcm="ops-card"]')].map((c) => ({
      open: c.open, tag: c.querySelector('summary .chip')?.textContent, title: c.querySelector('summary')?.textContent.trim(), w: c.getBoundingClientRect().width,
      items: [...c.querySelectorAll('.it')].map((i) => ({ cls: i.className.replace('it ', ''), mk: i.querySelector('.mk').textContent, text: i.textContent.trim().slice(0, 40) })),
      reps: [...c.querySelectorAll('.rep-title')].map((e) => e.textContent),
    })));
    out.V2 = cards;
    check(cards.length === 2 && cards[0].tag === 'Agent 操作' && cards[0].title === 'Agent 操作 第 1 轮 · 4 项操作' && cards[1].title === 'Agent 操作 第 2 轮 · 2 项操作', 'V2 操作卡片:「Agent 操作」+ 第 N 轮 · M 项操作', cards.map((c) => c.title));
    check(cards[1].open === true && cards[0].open === false, 'V2 在跑的一轮(最新)默认展开,旧的一轮折叠', cards.map((c) => c.open));
    // 点标题展开旧的一轮
    const sum0 = (await rects('[data-pcm="ops-card"] summary'))[0];
    await A.touchscreen.tap(sum0.x + 40, sum0.y + sum0.h / 2);
    await sleep(300);
    const opened = await A.evaluate(() => [...document.querySelectorAll('[data-pcm="ops-card"]')].map((c) => c.open));
    check(opened[0] === true, 'V2 点标题能展开旧的一轮', opened);
    const c0 = await A.evaluate(() => [...document.querySelectorAll('[data-pcm="ops-card"]')[0].querySelectorAll('.it')].map((i) => ({ cls: i.className.replace('it ', ''), mk: i.querySelector('.mk').textContent, text: i.textContent.trim() })));
    check(c0.slice(0, 4).map((i) => i.cls).join() === 'done,done,err,done' && c0[0].text.includes('读取 list_media') && c0[1].text.includes('新增 add_clip') && c0[2].text.includes('修改 set_clip_param'), 'V2 条目:类别 + 工具名,状态完成 / 失败', c0);
    check(c0.slice(4).map((i) => i.cls).join() === 'done,todo,ask' && c0[4].text.includes('夏日海边') && c0[6].text.includes('字体缺失'), 'V2 小结的已完成 / 待办 / 问题变成卡片里的行', c0);
    const c1 = await A.evaluate(() => [...document.querySelectorAll('[data-pcm="ops-card"]')[1].querySelectorAll('.it')].map((i) => i.className.replace('it ', '')));
    check(c1.join() === 'done,run', 'V2 在跑的一轮:最后一项是「在做」', c1);
    const colors = await A.evaluate(() => {
      const bg = (s) => getComputedStyle(document.querySelector(s)).backgroundColor;
      return { done: bg('.it.done .mk'), err: bg('.it.err .mk'), run: bg('.it.run .mk'), ask: bg('.it.ask .mk'), todo: bg('.it.todo .mk') };
    });
    out.V2.colors = colors;
    check(colors.done === 'rgb(76, 195, 138)' && colors.err === 'rgb(229, 96, 79)' && colors.run === 'rgb(38, 198, 230)' && colors.ask === 'rgb(232, 176, 74)', 'V2 状态色:完成绿、失败红、在做青蓝、问题黄(同演示稿的变量)', colors);
    const typing = await A.evaluate(() => ({ dots: document.querySelectorAll('[data-pcm="msg-typing"] .typing i').length, text: document.querySelector('[data-pcm="msg-typing"] .act')?.textContent }));
    out.V3.typing = typing;
    check(typing.dots === 3 && typing.text === '正在读取当前时间轴与你引用的片段', 'V3 还在跑的一轮末尾有三点和「正在做什么」', typing);
    await shot('view-chat-open');
  }
  // 出错、发送状态
  await render({ ...base, messages: [
    { id: 'u1', role: 'user', text: '你好', sendState: 'sending' },
    { id: 'u2', role: 'user', text: '再来一条', sendState: 'accepted' },
    { id: 'u3', role: 'user', text: '这条没发出去', sendState: 'failed', error: '使用云端 Agent 前,请先阅读并确认告知。' },
    { id: 'a1', role: 'assistant', text: '', parts: [tool('add_clip', {}, true)], error: '模型额度用完了', outcome: 'error' },
  ] });
  {
    const st = await A.evaluate(() => ({
      states: [...document.querySelectorAll('[data-pcm="msg-me"] .send-state')].map((e) => e.textContent),
      failed: document.querySelector('[data-pcm="send-failed"]')?.textContent, err: document.querySelector('[data-pcm="msg-error"]')?.textContent,
    }));
    out.V3.states = st;
    check(st.states.length === 2 && st.states[0] === '发送中…' && st.states[1].startsWith('已发出') && st.failed?.includes('确认告知') && st.err === '模型额度用完了', 'V3 发送状态(发送中 / 已发出 / 没发出去的原因)与出错原因', st);
    await shot('view-chat-states');
  }

  /* ================================================================ V4 引用标记条 */
  await render({ ...base, quotes: [{ id: 'c-9', label: '沙滩奔跑.mp4' }] });
  await shot('view-quote');
  {
    const bar = (await rects('[data-pcm="refbar"]'))[0], ta = (await rects('[data-pcm="chat-input"]'))[0], chip = (await rects('[data-pcm="ref-chip"]'))[0], x = (await rects('[data-pcm="ref-remove"]'))[0];
    const ph = await A.evaluate(() => document.querySelector('[data-pcm="chat-input"]').placeholder);
    out.V4 = { bar, ta, chip, x, ph };
    check(bar && ta && bar.b <= ta.y + 0.5, 'V4 引用标记条在输入框上方', { bar, ta });
    check(ph === '@沙滩奔跑.mp4 想怎么改?', 'V4 带引用时输入框的提示是「@名字 想怎么改?」', ph);
    // 演示稿在 prototypes/,社区版没有
    if (fs.existsSync(DEMO)) {
      const D = await phone();
      await D.goto(pathToFileURL(DEMO).href, { waitUntil: 'load' });
      await D.evaluate(() => { openProject('p1'); pageAgent(); });
      await sleep(500);
      await D.screenshot({ path: path.join(OUT, 'demo-view-chat.png') });
      await D.evaluate(() => { setRef('沙滩奔跑.mp4'); });
      await sleep(300);
      const dr = await D.evaluate(() => { const r = (s) => { const e = document.querySelector(s); const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, b: b.bottom }; }; return { chip: r('.refbar .ref'), x: r('.refbar .ref b'), bar: r('.refbar'), input: r('.in-row input'), composer: r('.composer') }; });
      await D.screenshot({ path: path.join(OUT, 'demo-view-quote.png') });
      out.V4.demo = dr;
      check(near(chip.h, dr.chip.h) && near(x.w, dr.x.w) && near(x.h, dr.x.h) && near(chip.x, dr.chip.x) && near(chip.y, dr.chip.y), 'V4 引用标记的尺寸与位置同演示稿(高、✕ 18×18、左上角)', { mine: chip, demo: dr.chip });
      check(near(bar.y, dr.bar.y) && near(ta.h, dr.input.h) && near(ta.y, dr.input.y), 'V4 标记条与输入框的位置同演示稿', { mine: { bar, ta }, demo: dr });
      for (const [mine, demo] of [['view-chat', 'view-chat'], ['view-quote', 'view-quote']]) sideBySide(path.join(OUT, `${mine}.png`), path.join(OUT, `demo-${demo}.png`), path.join(OUT, `side-${demo}.png`));
      await D.browserContext().close();
    }
  }

  /* ================================================================ V5 开始页 */
  const startBase = { ...base, tabs: [{ id: 't0', title: 'Agent 1', draft: true }], activeId: 't0', messages: [], draft: true };
  await render({ ...startBase, animated: true, guide: 'input' });
  await shot('view-start');
  {
    const st = await A.evaluate(() => ({ orb: !!document.querySelector('[data-pcm="agent-start-orb"]'), cue: !!document.querySelector('[data-pcm="agent-start-cue"]'), guide: document.querySelector('[data-pcm="agent-composer"]').getAttribute('data-guide'),
      orbAnim: getComputedStyle(document.querySelector('.orb .core')).animationName, glow: getComputedStyle(document.querySelector('.in-row textarea')).animationName, quicks: !!document.querySelector('[data-pcm="quicks"]') }));
    out.V5.animated = st;
    check(st.orb && st.cue && st.guide === 'input' && st.orbAnim !== 'none' && st.glow !== 'none', 'V5 刚进项目:光点 + 箭头在动,输入框带引导描边', st);
    check(!st.quicks, 'V5 开始页上没有快捷提问(有预设)', st);
    const pre = (await rects('[data-pcm="agent-start-preset"]'))[0], box = (await rects('[data-pcm="chat-msgs"]'))[0];
    check(pre && pre.x >= 14 && pre.r <= 375 - 14 && pre.y > box.y && pre.b < box.b, 'V5 预设按钮在消息区里、不出界', { pre, box });
  }
  await render({ ...startBase, animated: true, guide: 'send', inputText: '做一个动画告诉我使用软件可以干什么' });
  {
    const st = await A.evaluate(() => ({ guide: document.querySelector('[data-pcm="agent-composer"]').getAttribute('data-guide'), flash: getComputedStyle(document.querySelector('.send')).animationName }));
    check(st.guide === 'send' && st.flash !== 'none', 'V5 点预设后发送钮带引导(闪动)', st);
    await shot('view-start-preset');
  }
  await render({ ...startBase, animated: false, guide: null });
  {
    const st = await A.evaluate(() => ({ orb: !!document.querySelector('[data-pcm="agent-start-orb"]'), cue: !!document.querySelector('[data-pcm="agent-start-cue"]'), guide: document.querySelector('[data-pcm="agent-composer"]').getAttribute('data-guide'), preset: !!document.querySelector('[data-pcm="agent-start-preset"]'), input: !!document.querySelector('[data-pcm="chat-input"]'), title: document.querySelector('.start-title')?.textContent }));
    out.V5.cleared = st;
    check(!st.orb && !st.cue && !st.guide && st.preset && st.input && st.title === '开始', 'V5 手动清空后:没有光点和箭头、没有引导描边,只有预设和输入框', st);
    await shot('view-start-cleared');
  }
  // 减少动态效果:动画全关,只留静态描边
  await A.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await render({ ...startBase, animated: true, guide: 'input' });
  {
    const st = await A.evaluate(() => ({ orbAnim: getComputedStyle(document.querySelector('.orb .core')).animationName, cue: getComputedStyle(document.querySelector('.cue')).animationName, glow: getComputedStyle(document.querySelector('.in-row textarea')).animationName, border: getComputedStyle(document.querySelector('.in-row textarea')).borderColor }));
    out.V5.reduced = st;
    check(st.orbAnim === 'none' && st.cue === 'none' && st.glow === 'none' && st.border === 'rgb(38, 198, 230)', 'V5 系统设了「减少动态效果」:动画全关,只留静态描边', st);
  }
  await A.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);

  /* ================================================================ V6 标签行 */
  await render({ ...base, tabs: [{ id: 't1', title: 'Agent 1', busy: true }, { id: 't2', title: '剪辑1->序列2 这个范围名字特别特别长长长长长' }, { id: 't3', title: 'Agent 3' }], messages: [] });
  {
    const st = await A.evaluate(() => ({
      tabs: [...document.querySelectorAll('[data-pcm="atab"]')].map((e) => ({ t: e.querySelector('.nm').textContent, x: !!e.querySelector('[data-pcm="atab-close"]'), dot: !!e.querySelector('.dot.run'), w: e.getBoundingClientRect().width, h: e.getBoundingClientRect().height })),
      scrollW: document.querySelector('[data-pcm="atabs"]').scrollWidth, clientW: document.querySelector('[data-pcm="atabs"]').clientWidth, doc: document.documentElement.scrollWidth,
    }));
    out.V6 = st;
    check(st.tabs.length === 3 && st.tabs.every((t) => t.x && t.h === 30), 'V6 每个会话标签都带 ✕、高 30', st.tabs);
    check(st.tabs[0].dot && !st.tabs[1].dot, 'V6 忙着的会话有闪动的小点', st.tabs);
    check(st.tabs[1].w <= 120 + 4 + 16 + 10 + 4 + 2, 'V6 长标题被截断、不撑宽', st.tabs[1]);
    check(st.doc <= 375, 'V6 标签太多时只在标签行里横向滑动,不撑宽页面', st);
    await shot('view-tabs');
  }
  await render({ ...startBase });
  {
    const st = await A.evaluate(() => [...document.querySelectorAll('[data-pcm="atab"]')].map((e) => ({ t: e.querySelector('.nm').textContent, x: !!e.querySelector('[data-pcm="atab-close"]'), draft: e.dataset.draft })));
    check(st.length === 1 && st[0].t === '开始' && !st[0].x && st[0].draft === '1', 'V6 没有会话时只有一项「开始」、没有 ✕', st);
  }

  /* ================================================================ V7 停止钮 */
  await render({ ...base, streaming: true, inputText: '' });
  {
    const st = await A.evaluate(() => ({ stop: !!document.querySelector('[data-pcm="chat-stop"]'), send: !!document.querySelector('[data-pcm="chat-send"]') }));
    check(st.stop && !st.send, 'V7 在跑且输入框空:发送钮换成停止钮', st);
    await shot('view-stop');
  }
  await render({ ...base, streaming: true, inputText: '再补一句' });
  {
    const st = await A.evaluate(() => ({ stop: !!document.querySelector('[data-pcm="chat-stop"]'), send: !!document.querySelector('[data-pcm="chat-send"]') }));
    check(!st.stop && st.send, 'V7 在跑但输入框里有字:仍是发送钮(排队发送)', st);
  }

  /* ================================================================ V8 溢出与报错 */
  for (const [label, s] of [['chat', base], ['quote', { ...base, quotes: [{ id: 'c-9', label: '一个特别特别特别特别特别特别特别特别长的素材名字.mp4' }] }], ['start', { ...startBase, animated: true }]]) {
    await render(s);
    const w = await A.evaluate(() => ({ doc: document.documentElement.scrollWidth, pcm: document.querySelector('.pcm').scrollWidth, vw: innerWidth }));
    out.V8[label] = w;
    check(w.doc <= w.vw && w.pcm <= w.vw, `V8 375 宽无横向溢出(${label})`, w);
  }
  out.V8.pageErrors = A.errors;
  check(A.errors.length === 0, 'V8 页面没有报错', A.errors);
} catch (e) {
  fails.push(`探针异常:${e?.stack ?? e}`);
} finally {
  out.ok = fails.length === 0;
  out.fails = fails;
  await browser.close().catch(() => {});
  await vite.close().catch(() => {});
  await new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });
  console.log(JSON.stringify(out));
  process.exit(out.ok ? 0 : 1);
}
