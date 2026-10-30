/**
 * 手机版 Agent 分页的验收探针(分支 claude/mobile-agent-page;语义 `docs/semantics/workflow/editing.md`「手机版界面」「AI 栏的 Agent 标签」;
 * 演示稿 `prototypes/mobile-ui-demo/` 的 Agent 页)。
 * 全程在本机:本机托管组合 + 仿 nginx 的代理(`lib/mobile-env.mjs`),在线构建当页面,绝不连真正的托管端。
 *
 *   npx vite build --mode online
 *   node scripts/probes/mobile-agent-probe.mjs [--dist dist-online] [--out <截图目录>] [--base-port 5980] [--doc-port 5983] [--asset-port 5987]
 *
 * 验收(安卓仿真 375×812、触屏;每项一行进最后那行 JSON 的 `fails`):
 *   S 没有会话时是开始页:只有「开始」一项标签(没有 ✕)、预设按钮、输入框;刚进项目带引导动画(光点、箭头、输入框引导);
 *     点预设 → 句子进输入框、发送按钮进入「催发送」;点发送之前没有会话(分页清单里没有真页);点发送才建 Agent 1、这条消息在里面;
 *   C 清空:关掉 Agent 1 回到开始页,不放引导动画(没有光点和箭头),预设和输入框还在;
 *   Q 引用标记条:选中缩略卡点「引用」→ 切到 Agent 分页,标记条出现在输入框上方(底边 ≤ 输入框顶边),带名字和 ✕;
 *     重复点同一项不重复放;点 ✕ 去掉;发送时消息带着引用(气泡上画成标记、正文里是「@卡片 名字(片段 id)」),发送后标记条清空;
 *   T 标签:「+」在有会话时新开 Agent 2(取最小空号),每个会话都能关(有对话先问一声);
 *   D 和演示稿对得上(同 375×812):对话标签行高 30、创造力一行、输入框 40 高、发送钮 40×40、快捷提问 28 高、整块输入区高度与位置、引用标记条的尺寸;
 *   (对话页的画法 —— 气泡、操作卡片、小结行、开始页动画、标签行、停止钮 —— 在 `mobile-agent-view-probe.mjs` 里用假消息测。)
 *   W 375 宽无横向溢出,页面无未捕获错误。
 * 截图:`agent-*.png` 与演示稿同尺寸并排的 `side-*.png`。结果最后一行是一行 JSON(`ok`、`fails`、各项数字)。
 *
 * 说明:本机托管组合没有云端 Agent 服务、也没有网站账号,所以发消息走到「请先登录当前项目的账号」就停(气泡标「没有发出去」);
 * 这正好够验「点发送建会话、消息带引用」(读页面上的只读口子 `window.__pcMobileAgent[会话].lastSend()`,同 `__pcCloud` 一类)。
 * 为了让页面走到发送那一段,探针在页面收到成员列表时把 `hosted.agent` 改成「可用、开着」(模拟托管端有云端 Agent;本机组合没有)。
 */
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PNG } from 'pngjs';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { startMobileEnv, emptyProject, solidPng } from './lib/mobile-env.mjs';

setTimeout(() => { console.error('SCRIPT_TIMEOUT'); process.exit(124); }, 12 * 60_000).unref();

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.resolve(arg('--dist', path.join(ROOT, 'dist-online')));
const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), 'mobile-agent-shots')));
const DEMO = path.join(ROOT, 'prototypes', 'mobile-ui-demo', 'index.html');
const BASE = Number(arg('--base-port', 5980));
const DOC = Number(arg('--doc-port', 5983));
const ASSET = Number(arg('--asset-port', 5987));
for (const p of [BASE, BASE + 1, BASE + 2, DOC, ASSET]) if (p < 5980 || p > 5989) throw new Error(`端口 ${p} 不在分给本探针的 5980～5989 里`);
fs.mkdirSync(OUT, { recursive: true });

const PRESET = '做一个动画告诉我使用软件可以干什么';
const fails = [];
const out = { ok: false, out: OUT, S: {}, C: {}, Q: {}, T: {}, D: {}, W: {} };
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 500))); return !!cond; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 20_000, every = 200) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) { fails.push(`等不到:${what}`); return null; }
    await sleep(every);
  }
}
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`) }).catch(() => {});
const rect = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, b: r.bottom }; }, sel);
const center = async (page, sel) => { const r = await rect(page, sel); return r && { x: r.x + r.w / 2, y: r.y + r.h / 2 }; };
const tap = async (page, sel) => { const c = await center(page, sel); if (!c) throw new Error(`点不到 ${sel}`); await page.touchscreen.tap(c.x, c.y); await sleep(300); };
const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent?.trim() ?? null, sel);
const pageName = (page) => page.evaluate(() => document.querySelector('[data-pcm="editor"]')?.getAttribute('data-page'));

/** 两张同高的图左右拼起来(左:实现,右:演示稿) */
function sideBySide(left, right, file) {
  const a = PNG.sync.read(fs.readFileSync(left)), b = PNG.sync.read(fs.readFileSync(right));
  const h = Math.max(a.height, b.height), w = a.width + 16 + b.width;
  const o = new PNG({ width: w, height: h });
  o.data.fill(40);
  PNG.bitblt(a, o, 0, 0, a.width, a.height, 0, 0);
  PNG.bitblt(b, o, 0, 0, b.width, b.height, a.width + 16, 0);
  fs.writeFileSync(file, PNG.sync.write(o));
}

const env = await startMobileEnv({ dist: DIST, basePort: BASE, docPort: DOC, assetPort: ASSET, name: `mobile-agent-${Date.now().toString(36)}` });
const seeded = await env.seed(emptyProject('夏日海边 Vlog'));
check(!/error|reject/i.test(`${seeded.opened}${seeded.seeded}`), '替创建者写进初始项目', seeded);
const browser = await puppeteer.launch({ headless: true, ignoreDefaultArgs: ['--hide-scrollbars'], protocolTimeout: 600_000, args: [...PROBE_CHROME_ARGS, '--no-first-run'] });
let A = null;
try {
  A = await env.newPage(browser, 'phone');
  // 本机托管组合没有云端 Agent 服务(成员列表里 hosted.agent.available 是假):在页面收到成员列表时把它改成「可用、开着」,让发送走得到页面自己的那一段
  await A.evaluateOnNewDocument(`(() => {
    // 模拟「创建者开了云端 Agent」会让同步层弹一条桌面样式的气泡(盖在标签行上、拦触摸),与本探针要测的东西无关,藏掉
    const hideToasts = () => { const st = document.createElement('style'); st.textContent = '.pc-toasts{display:none!important}'; (document.head || document.documentElement).appendChild(st); };
    if (document.documentElement) hideToasts(); else document.addEventListener('DOMContentLoaded', hideToasts);
    const fix = (data) => { if (typeof data !== 'string' || !data.includes('shared.members.list')) return data; try { const m = JSON.parse(data); if (m && m.type === 'shared.members.list') { m.hosted = { ...(m.hosted || {}), agent: { available: true, enabled: true, url: location.origin + '/agent/v1' } }; return JSON.stringify(m); } } catch (e) {} return data; };
    const wrap = (ev) => new Proxy(ev, { get: (t, k) => (k === 'data' ? fix(t.data) : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
    const add = WebSocket.prototype.addEventListener;
    WebSocket.prototype.addEventListener = function (type, fn, opts) { if (type === 'message' && typeof fn === 'function') { const w = (ev) => fn.call(this, wrap(ev)); fn.__w = fn.__w || new WeakMap(); fn.__w.set(this, w); return add.call(this, type, w, opts); } return add.call(this, type, fn, opts); };
    const rem = WebSocket.prototype.removeEventListener;
    WebSocket.prototype.removeEventListener = function (type, fn, opts) { const w = type === 'message' && fn && fn.__w && fn.__w.get(this); return rem.call(this, type, w || fn, opts); };
    const d = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage');
    Object.defineProperty(WebSocket.prototype, 'onmessage', { configurable: true, get: d.get, set(fn) { d.set.call(this, typeof fn === 'function' ? (ev) => fn.call(this, wrap(ev)) : fn); } });
  })();`);
  await env.enter(A);
  await A.waitForSelector('[data-pcm="pg-agent"]', { visible: true, timeout: 60_000 });
  const projectId = await A.evaluate(() => window.__pcStore.getState().project.id);
  const tabsOf = () => A.evaluate((pid) => {
    try { const j = JSON.parse(localStorage.getItem(`pc.agentTabs:${pid}`) ?? 'null'); return j ? { tabs: j.tabs.map((t) => ({ id: t.id, title: t.title })), cleared: j.cleared === true } : null; } catch { return null; }
  }, projectId);
  const labels = () => A.evaluate(() => [...document.querySelectorAll('[data-pcm="atab"]')].map((e) => ({ t: e.querySelector('.nm')?.textContent, draft: e.getAttribute('data-draft') === '1', x: !!e.querySelector('[data-pcm="atab-close"]'), on: e.classList.contains('on') })));
  const shownChat = () => A.evaluate(() => {
    const e = document.querySelector('[data-pcm="agent-chat"][data-shown="1"]');
    return e ? { id: e.getAttribute('data-tab'), start: !!e.querySelector('[data-pcm="agent-start"]'), animated: e.querySelector('[data-pcm="agent-start"]')?.getAttribute('data-animated') ?? null, orb: !!e.querySelector('[data-pcm="agent-start-orb"]'), cue: !!e.querySelector('[data-pcm="agent-start-cue"]'), preset: e.querySelector('[data-pcm="agent-start-preset"]')?.textContent ?? null, guide: e.querySelector('[data-pcm="agent-composer"]')?.getAttribute('data-guide') ?? null, input: e.querySelector('textarea')?.value ?? null, msgs: [...e.querySelectorAll('[data-pcm="msg-me"], [data-pcm="msg-ag"]')].length } : null;
  });
  const noOverflow = async (label) => {
    const w = await A.evaluate(() => ({ doc: document.documentElement.scrollWidth, pcm: document.querySelector('.pcm')?.scrollWidth ?? 0, vw: innerWidth }));
    out.W[label] = w;
    check(w.doc <= w.vw && w.pcm <= w.vw, `W 375 宽无横向溢出(${label})`, w);
  };

  /* ================================================================ S 开始页 */
  await tap(A, '[data-pcm="pg-agent"]');
  await until('切到 Agent 分页', async () => (await pageName(A)) === 'agent');
  await until('开始页', () => A.$('[data-pcm="agent-start"]'), 30_000);
  await sleep(500);
  {
    const l = await labels(), c = await shownChat(), t0 = await tabsOf();
    out.S.initial = { labels: l, chat: c, stored: t0 };
    check(l.length === 1 && l[0].draft && l[0].t === '开始' && !l[0].x && l[0].on, 'S 没有会话时只有「开始」一项标签,没有 ✕', l);
    check(c?.start && c.animated === '1' && c.orb && c.cue && c.preset === PRESET, 'S 刚进项目:开始页带引导动画(光点、箭头)和预设按钮', c);
    check(c?.guide === 'input', 'S 刚进项目:输入框带引导', c);
    check(!t0 || t0.tabs.length === 0, 'S 点发送之前清单里没有真页', t0);
    const ta = await rect(A, '[data-pcm="chat-input"]');
    check(!!ta && ta.w > 200, 'S 开始页上有输入框', ta);
    await noOverflow('agent-start');
    await shot(A, 'agent-start');
  }
  // 点预设:句子进输入框、发送按钮催发送;还没有会话
  await tap(A, '[data-pcm="agent-start-preset"]');
  {
    const c = await shownChat(), t0 = await tabsOf();
    out.S.afterPreset = { chat: c, stored: t0 };
    check(c?.input === PRESET && c.guide === 'send', 'S 点预设:句子进输入框、发送按钮进入催发送', c);
    check(c?.start && (!t0 || t0.tabs.length === 0), 'S 点预设之后仍是开始页、没有建会话', { c, t0 });
    await shot(A, 'agent-start-preset');
  }

  /* ================================================================ Q 引用标记条(在开始页上也能带引用):先导入三张图到主要内容 */
  await tap(A, '[data-pcm="top-back"]');
  await until('回缩略预览', async () => (await pageName(A)) === 'preview');
  const imgs = [];
  for (const [i, rgb] of [[1, [200, 60, 50]], [2, [40, 160, 90]], [3, [50, 90, 200]]]) imgs.push(await solidPng(path.join(OUT, `img-${i}.png`), rgb));
  await tap(A, '[data-pcm="sub-image"]');
  await A.waitForSelector('[data-pcm="sheet-assets"]', { visible: true });
  await (await A.$('[data-pcm="import-input"]')).uploadFile(...imgs);
  await until('三张图进素材库', async () => (await A.$$('[data-pcm="asset"]')).length >= 3, 60_000, 300);
  for (let i = 0; i < 3; i++) {
    if (!(await A.$('[data-pcm="sheet-assets"]'))) { await tap(A, '[data-pcm="sub-image"]'); await A.waitForSelector('[data-pcm="asset"]', { visible: true }); }
    await A.evaluate((k) => document.querySelectorAll('[data-pcm="asset"]')[k].scrollIntoView(), i);
    const r = await (await A.$$('[data-pcm="asset"]'))[i].boundingBox();
    await A.touchscreen.tap(r.x + r.width / 2, r.y + r.height / 2);
    await sleep(500);
  }
  await until('缩略时间轴三张缩略卡', async () => (await A.$$('[data-pcm="mblock"]')).length === 3);
  // 选中第一张缩略卡 → 子导航栏第一个「引用」
  {
    const blocks = await A.$$('[data-pcm="mblock"]');
    const r = await blocks[0].boundingBox();
    await A.touchscreen.tap(r.x + r.width / 2, r.y + r.height / 2);
    await sleep(400);
    const first = await A.evaluate(() => document.querySelector('[data-pcm="subnav-preview"] button')?.textContent?.trim());
    check(first === '引用', 'Q 选中缩略卡后子导航栏第一个是「引用」', first);
    await tap(A, '[data-pcm="subnav-preview"] button');
    await until('切到 Agent 分页', async () => (await pageName(A)) === 'agent');
    await until('引用标记条出现', () => A.$('[data-pcm="refbar"]'), 8000);
    const bar = await rect(A, '[data-pcm="refbar"]'), ta = await rect(A, '[data-pcm="chat-input"]'), chip = await rect(A, '[data-pcm="ref-chip"]');
    const label = await text(A, '[data-pcm="ref-chip"]');
    out.Q.bar = { bar, ta, chip, label };
    check(!!bar && !!ta && bar.b <= ta.y + 0.5, 'Q 引用标记条在输入框上方(底边 ≤ 输入框顶边)', { bar, ta });
    check(!!chip && /^@\s/.test(label ?? '') && /✕$/.test(label ?? ''), 'Q 标记条里是「@ 名字 ✕」', label);
    const c = await shownChat();
    check(c?.start === true && c.input === PRESET, 'Q 开始页上点「引用」:仍是开始页、输入框里的话还在(引用不往输入框里插字)', c);
    await shot(A, 'agent-quote-start');
    // 再引用同一项:不重复
    await tap(A, '[data-pcm="top-back"]');
    await until('回缩略预览', async () => (await pageName(A)) === 'preview');
    await tap(A, '[data-pcm="subnav-preview"] button');
    await until('再切到 Agent 分页', async () => (await pageName(A)) === 'agent');
    await sleep(300);
    const n = (await A.$$('[data-pcm="ref-chip"]')).length;
    check(n === 1, 'Q 重复引用同一项不重复放', n);
    // 点 ✕ 去掉
    await tap(A, '[data-pcm="ref-remove"]');
    check(!(await A.$('[data-pcm="refbar"]')), 'Q 点 ✕ 去掉引用,标记条收起', null);
    // 再引用一次,准备发送
    await tap(A, '[data-pcm="top-back"]');
    await until('回缩略预览', async () => (await pageName(A)) === 'preview');
    await tap(A, '[data-pcm="subnav-preview"] button');
    await until('再切到 Agent 分页', async () => (await pageName(A)) === 'agent');
    await until('引用标记条出现', () => A.$('[data-pcm="refbar"]'), 8000);
    out.Q.label = (await text(A, '[data-pcm="ref-chip"]'))?.replace(/^@\s*/, '').replace(/✕$/, '').trim();
  }

  /* ================================================================ S 点发送才建 Agent 1,消息带引用 */
  await tap(A, '[data-pcm="chat-send"]');
  await until('建出 Agent 1', async () => (await labels()).some((x) => x.t === 'Agent 1'), 15_000);
  await sleep(800);
  {
    const l = await labels(), t1 = await tabsOf(), c = await shownChat();
    const sent = await A.evaluate(() => { const hooks = window.__pcMobileAgent ?? {}; return Object.entries(hooks).map(([id, h]) => ({ id, last: h.lastSend() })).find((x) => x.last) ?? null; });
    out.S.afterSend = { labels: l, stored: t1, chat: c, sent };
    check(l.length === 1 && l[0].t === 'Agent 1' && l[0].x && !l[0].draft, 'S 点发送后建出 Agent 1(带 ✕,不再是开始页)', l);
    check(t1?.tabs.length === 1 && t1.tabs[0].title === 'Agent 1' && t1.tabs[0].id.startsWith(projectId + '_') && t1.tabs[0].id.length > projectId.length + 1, 'S 分页标记是「项目ID_AgentID」', t1);
    check(c && !c.start, 'S 点发送后不再是开始页', c);
    check(sent && sent.id === t1?.tabs[0]?.id, 'S 这条消息是在新建出来的 Agent 1 里发的', { sent, t1 });
    // 发出去的正文:引用写法 @卡片 名字(片段 id) 正文
    check(sent && /^@卡片 .+\([^()\s]+\) /.test(sent.last.text) && sent.last.text.endsWith(' ' + PRESET) && sent.last.quotes.length === 1 && sent.last.text.includes(`@卡片 ${out.Q.label}(`), 'Q 发送带上引用:正文是「@卡片 名字(片段 id) 正文」', sent);
    check(!(await A.$('[data-pcm="refbar"]')) || (await A.$$('[data-pcm="ref-chip"]')).length === 1, 'Q 没发出去时引用放回标记条(不丢);发出去了标记条清空', null);
    out.Q.sent = sent?.last;
    await shot(A, 'agent-sent');
  }
  /* ================================================================ C 清空:关掉 Agent 1 → 开始页不放引导动画
     (本机环境发不出消息,会话里没有消息;关「有对话的会话」先问一声,经 AgentPage 里那份各会话消息条数的记录来触发) */
  await A.evaluate(() => {
    const el = document.querySelector('[data-pcm="agent-page"]');
    let f = el[Object.keys(el).find((k) => k.startsWith('__reactFiber$'))];
    while (f && !(f.memoizedProps && typeof f.memoizedProps.active === 'boolean' && typeof f.type === 'function')) f = f.return;
    for (let h = f?.memoizedState; h; h = h.next) { const v = h.memoizedState; if (v && v.current instanceof Map && v.current.size > 0 && [...v.current.keys()].every((k) => typeof k === 'string' && k.endsWith('_start'))) { for (const k of [...v.current.keys()]) v.current.set(k, 2); window.__counts = v.current; return; } }
  });
  out.C.countsHooked = await A.evaluate(() => !!window.__counts);
  check(out.C.countsHooked, 'T (探针)找得到各会话消息条数的记录', null);
  await tap(A, '[data-pcm="atab-close"]');
  await sleep(300);
  {
    const confirm = await A.$('[data-pcm="confirm"]');
    check(!!confirm, 'T 关有对话的会话先问一声(取消不关)', null);
    if (confirm) {
      const cancel = await A.evaluate(() => { const b = [...document.querySelectorAll('[data-pcm="confirm"] .btn')].find((x) => x.textContent === '取消'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
      await A.touchscreen.tap(cancel.x, cancel.y);
      await sleep(300);
      check((await labels()).some((x) => x.t === 'Agent 1'), 'T 取消之后会话还在', await labels());
      await tap(A, '[data-pcm="atab-close"]');
      await sleep(300);
      await tap(A, '[data-pcm="confirm-ok"]');
    }
    await until('回到开始页', () => A.$('[data-pcm="agent-start"]'), 8000);
    await sleep(500);
    const l = await labels(), c = await shownChat(), t2 = await tabsOf();
    out.C = { ...out.C, labels: l, chat: c, stored: t2 };
    check(l.length === 1 && l[0].draft && l[0].t === '开始' && !l[0].x, 'C 最后一个会话也能关,关光后回到只有「开始」一项', l);
    check(c?.start && c.animated === '0' && !c.orb && !c.cue && c.preset === PRESET, 'C 手动清空后开始页不放引导动画,只有预设和输入框', c);
    check(c?.guide === null, 'C 清空后输入框不带引导', c);
    check(t2?.cleared === true && t2.tabs.length === 0, 'C 记下「手动清空过」(按项目)', t2);
    await noOverflow('agent-cleared');
    await shot(A, 'agent-cleared');
    // 清空后点预设仍会催发送(预设那一下的提示两种开始页都有),但不带引导动画
    await tap(A, '[data-pcm="agent-start-preset"]');
    const c2 = await shownChat();
    check(c2?.input === PRESET && c2.guide === 'send' && !c2.orb, 'C 清空后点预设:句子进输入框、发送钮催发送,仍没有光点', c2);
  }

  /* ================================================================ T 标签:有会话时「+」新开 Agent 2(最小空号);可关;切换 */
  await tap(A, '[data-pcm="chat-send"]');
  await until('建出 Agent 1', async () => (await labels()).some((x) => x.t === 'Agent 1'), 15_000);
  const firstId = (await tabsOf())?.tabs[0]?.id;
  await tap(A, '[data-pcm="atab-new"]');
  await until('新开 Agent 2', async () => (await labels()).some((x) => x.t === 'Agent 2'), 8000);
  {
    const l = await labels();
    out.T.two = l;
    check(l.length === 2 && l[0].t === 'Agent 1' && l[1].t === 'Agent 2' && l[1].on && l.every((x) => x.x), 'T 有会话时「+」新开 Agent 2 并切过去,每个标签都有 ✕', l);
    const c = await shownChat();
    check(c && !c.start && c.id !== firstId, 'T 新开的会话不是开始页(只有没有会话时才是),显示的是新会话', c);
    // 切回 Agent 1:显示的页跟着换,另一页还挂着(后台的对话照跑)
    await tap(A, '[data-pcm="atab"]:nth-of-type(1)');
    const c1 = await shownChat();
    const mounted = await A.evaluate(() => document.querySelectorAll('[data-pcm="agent-chat"]').length);
    check(c1?.id === firstId && mounted === 2, 'T 点标签切换会话;没显示的会话仍挂着(不卸载)', { c1, mounted });
    await tap(A, '[data-pcm="atab"]:nth-of-type(2)');
    // 空的新会话:直接关(不用问)
    await tap(A, '[data-pcm="atab"]:nth-of-type(2) [data-pcm="atab-close"]');
    await sleep(400);
    const l2 = await labels();
    check(!(await A.$('[data-pcm="confirm"]')) && l2.length === 1 && l2[0].t === 'Agent 1' && l2[0].on, 'T 空会话直接关掉、不用问;关的是当前页就切到相邻的', l2);
    await tap(A, '[data-pcm="atab-new"]');
    await until('再开一个', async () => (await labels()).length === 2);
    const l3 = await labels();
    check(l3[1].t === 'Agent 2', 'T 新建取当前最小的空号', l3);
    // 刷新页面:这个项目的两个标签还在(按项目存在本机)
    const stored = await tabsOf();
    check(stored?.tabs.length === 2 && stored.tabs.every((t) => t.id.startsWith(projectId + '_')), 'T 标签清单按项目存,每个标记是「项目ID_AgentID」', stored);
    await tap(A, '[data-pcm="atab"]:nth-of-type(2) [data-pcm="atab-close"]');
    await sleep(300);
  }

  /* ================================================================ D 和演示稿对得上 + 并排截图 */
  {
    const D = await env.newPage(browser, 'phone');
    await D.goto(pathToFileURL(DEMO).href, { waitUntil: 'load' });
    await D.evaluate(() => { openProject('p1'); pageAgent(); });
    await sleep(500);
    const demoMetrics = await D.evaluate(() => {
      const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, b: b.bottom }; };
      return { top: r('.chat-top'), atab: r('.atab'), plus: r('.chat-top .icon-btn'), info: r('.chat-info'), level: r('.level'), levelBtn: r('.level button'), msgs: r('.msgs'), composer: r('.composer'), quick: r('.quicks button'), quicks: r('.quicks'), input: r('.in-row input'), send: r('.send'), pager: r('.pager') };
    });
    await D.screenshot({ path: path.join(OUT, 'demo-agent.png') });
    // 演示稿的引用标记条
    await D.evaluate(() => { setRef('沙滩奔跑.mp4'); });
    await sleep(200);
    const demoRef = await D.evaluate(() => { const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, b: b.bottom }; }; return { bar: r('.refbar'), chip: r('.refbar .ref'), x: r('.refbar .ref b'), input: r('.in-row input'), composer: r('.composer') }; });
    await D.screenshot({ path: path.join(OUT, 'demo-agent-quote.png') });
    out.D.demo = demoMetrics; out.D.demoRef = demoRef;

    // 我这边:回到一个有会话、没有引用的状态(Agent 1,放进消息),量同样的东西
    const mine = () => A.evaluate(() => {
      const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, b: b.bottom }; };
      return { top: r('[data-pcm="chat-top"]'), atab: r('[data-pcm="atab"]'), plus: r('[data-pcm="atab-new"]'), info: r('[data-pcm="chat-info"]'), level: r('[data-pcm="creativity"]'), levelBtn: r('[data-pcm="creativity"] button'), msgs: r('[data-pcm="chat-msgs"]'), composer: r('[data-pcm="agent-composer"]'), quick: r('[data-pcm="quicks"] button'), quicks: r('[data-pcm="quicks"]'), input: r('[data-pcm="chat-input"]'), send: r('[data-pcm="chat-send"]'), pager: r('[data-pcm="pager"]') };
    });
    const m = await mine();
    out.D.mine = m;
    const dm = demoMetrics;
    const same = (a, b, keys, tol = 1) => keys.every((k) => near(a[k], b[k], tol));
    check(same(m.atab, dm.atab, ['h']), 'D 对话标签高 30', { mine: m.atab, demo: dm.atab });
    check(same(m.top, dm.top, ['x', 'w']) && near(m.info.y - m.top.y, dm.info.y - dm.top.y), 'D 标签行左右各 10、与创造力一行的间距同演示稿(演示稿多一条状态栏,只比相对位置)', { mine: m.top, demo: dm.top });
    check(same(m.plus, dm.plus, ['w', 'h']), 'D 「+」按钮 34×34', { mine: m.plus, demo: dm.plus });
    check(near(m.info.h, dm.info.h) && near(m.msgs.y - m.info.y, dm.msgs.y - dm.info.y), 'D 创造力一行的高度、与消息区的间距', { mine: m.info, demo: dm.info });
    check(same(m.level, dm.level, ['w', 'h']) && same(m.levelBtn, dm.levelBtn, ['h']), 'D 创造力分段控件尺寸', { mine: m.level, demo: dm.level });
    check(same(m.composer, dm.composer, ['y', 'h', 'b']), 'D 输入区整块的位置与高度', { mine: m.composer, demo: dm.composer });
    check(same(m.input, dm.input, ['x', 'h', 'w']), 'D 输入框 40 高、宽度对齐', { mine: m.input, demo: dm.input });
    check(same(m.send, dm.send, ['w', 'h', 'x']), 'D 发送钮 40×40、位置对齐', { mine: m.send, demo: dm.send });
    check(same(m.quick, dm.quick, ['h', 'y']) && same(m.quicks, dm.quicks, ['y', 'h']), 'D 快捷提问 28 高、位置对齐', { mine: m.quick, demo: dm.quick });
    check(near(m.msgs.b, dm.msgs.b) && near(m.msgs.b, m.composer.y), 'D 消息区底边贴着输入区(同演示稿)', { mine: m.msgs, demo: dm.msgs });
    check(same(m.pager, dm.pager, ['y', 'h']), 'D 底部导航栏同位', { mine: m.pager, demo: dm.pager });
    await shot(A, 'agent-chat-metrics');

    // 引用标记条:再点一次「引用」(在会话里)
    await tap(A, '[data-pcm="top-back"]');
    await until('回缩略预览', async () => (await pageName(A)) === 'preview');
    {
      const blocks = await A.$$('[data-pcm="mblock"]');
      const r = await blocks[1].boundingBox();
      await A.touchscreen.tap(r.x + r.width / 2, r.y + r.height / 2);
      await sleep(400);
    }
    await tap(A, '[data-pcm="subnav-preview"] button');
    await until('切到 Agent 分页', async () => (await pageName(A)) === 'agent');
    await until('引用标记条出现', () => A.$('[data-pcm="refbar"]'), 8000);
    await sleep(300);
    const mr = await A.evaluate(() => { const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, b: b.bottom }; }; return { bar: r('[data-pcm="refbar"]'), chip: r('[data-pcm="ref-chip"]'), x: r('[data-pcm="ref-remove"]'), input: r('[data-pcm="chat-input"]'), composer: r('[data-pcm="agent-composer"]') }; });
    out.D.mineRef = mr;
    check(near(mr.chip.h, demoRef.chip.h) && near(mr.x.w, demoRef.x.w) && near(mr.x.h, demoRef.x.h) && near(mr.chip.x, demoRef.chip.x), 'D 引用标记尺寸(高、✕ 18×18、左边距)与演示稿一致', { mine: mr.chip, demo: demoRef.chip });
    check(near(mr.composer.h, demoRef.composer.h) && near(mr.input.y, demoRef.input.y) && near(mr.bar.y, demoRef.bar.y) && near(mr.bar.h, demoRef.bar.h), 'D 带引用标记条时输入区高度、输入框与标记条的位置与演示稿一致', { mine: mr, demo: demoRef });
    await shot(A, 'agent-quote');
    await noOverflow('agent-quote');

    for (const [mine2, demo] of [['agent-chat-metrics', 'agent'], ['agent-quote', 'agent-quote']]) {
      const a = path.join(OUT, `${mine2}.png`), b = path.join(OUT, `demo-${demo}.png`);
      if (fs.existsSync(a) && fs.existsSync(b)) sideBySide(a, b, path.join(OUT, `side-${demo}.png`));
    }
    out.sides = fs.readdirSync(OUT).filter((f) => f.startsWith('side-'));
    await D.browserContext().close();
  }
} catch (e) {
  fails.push(`探针异常:${e?.stack ?? e}`);
  if (A) await shot(A, 'agent-failure');
} finally {
  out.ok = fails.length === 0;
  out.fails = fails;
  await browser.close().catch(() => {});
  await env.close();
  console.log(JSON.stringify(out));
  process.exit(out.ok ? 0 : 1);
}
