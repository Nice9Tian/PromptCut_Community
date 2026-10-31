/**
 * 手机版界面的验收探针(任务书 `docs/plan/mobile-online-task.md` 的 M1 真页面一半与 M2)。
 * 全程在本机:本机托管组合 + 仿 nginx 的代理(`lib/mobile-env.mjs`),在线构建当页面,绝不连真正的托管端。
 *
 *   npx vite build --mode online
 *   node scripts/probes/mobile-ui-probe.mjs [--dist dist-online] [--out <截图目录>] [--base-port 5820] [--base2-port 5825] [--doc-port 5828] [--asset-port 5829]
 *   生产上的检查(不进项目、不改数据)见 闭源一侧的 `mobile-prod-check.mjs`。
 *
 * M1:安卓 Chrome 仿真(UA + userAgentData.mobile=true)进手机版;桌面仿真进桌面界面;`?layout=desktop|mobile` 能强制。
 * M2(375×812、触屏,逐条对演示稿第四～十三轮 README 里可量的条目):
 *   N 底部导航栏三项 113×46、图标 22×22、Agent 未选中是渐变圆、选中外圈描边;
 *   S 子导航栏两页同高同位、选中时第一个是「引用」;
 *   C 冲突横条在顶栏正下方、处理完收起(两名成员 + 掐断甲的连接造出真实的待合并);
 *   T 缩略卡点选、长按换序、点 ◇ 原地选中(不切分页);
 *   Z 完整时间轴 ＋ / − 以播放头为中心、适应宽度、双指捏合(CDP 两个触点)以中点为中心且不误选;
 *   B 返回层级与浏览器后退;
 *   R 滚动条 offsetWidth - clientWidth = 5(竖向)、offsetHeight - clientHeight = 5(横向);
 *   W 375 宽无横向溢出,控制台无报错;
 *   截图:关键页面与演示稿同尺寸并排(`side-*.png`)。
 * 结果最后一行是一行 JSON(`ok`、`fails`、各项数字)。
 */
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PNG } from 'pngjs';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { startMobileEnv, emptyProject, solidPng } from './lib/mobile-env.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.resolve(arg('--dist', path.join(ROOT, 'dist-online')));
const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), 'mobile-ui-shots')));
const DEMO = path.join(ROOT, 'prototypes', 'mobile-ui-demo', 'index.html');
fs.mkdirSync(OUT, { recursive: true });

const fails = [];
const out = { ok: false, out: OUT, M1: {}, N: {}, S: {}, C: {}, T: {}, Z: {}, B: {}, R: {}, W: {} };
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 400))); return !!cond; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 15_000, every = 200) {
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
const rect = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }, sel);
const center = async (page, sel) => { const r = await rect(page, sel); return r && { x: r.x + r.w / 2, y: r.y + r.h / 2 }; };
const tap = async (page, sel) => { const c = await center(page, sel); if (!c) throw new Error(`点不到 ${sel}`); await page.touchscreen.tap(c.x, c.y); await sleep(250); };
const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent?.trim() ?? null, sel);
const store = (page, src, ...a) => page.evaluate((s, a2) => new Function('S', 'args', s)(window.__pcStore, a2), src, a);
/** CDP 触屏:一组触点按下、逐步移动、抬起(生成 pointerType=touch 的 Pointer Events) */
async function touch(page, steps, { holdMs = 0, stepMs = 16 } = {}) {
  const send = (type, pts) => page.cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: i + 1 })) });
  await send('touchStart', steps[0]);
  if (holdMs) await sleep(holdMs);
  for (const pts of steps.slice(1)) { await send('touchMove', pts); await sleep(stepMs); }
  await send('touchEnd', []);
  await sleep(250);
}
const lerp = (a, b, n) => Array.from({ length: n + 1 }, (_, i) => [{ x: a.x + (b.x - a.x) * i / n, y: a.y + (b.y - a.y) * i / n }]);

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

const env = await startMobileEnv({
  dist: DIST, basePort: Number(arg('--base-port', 5820)), base2Port: Number(arg('--base2-port', 5825)),
  docPort: Number(arg('--doc-port', 5828)), assetPort: Number(arg('--asset-port', 5829)), name: `mobile-ui-${Date.now().toString(36)}`,
});
const seeded = await env.seed(emptyProject('夏日海边 Vlog'));
check(!/error|reject/i.test(`${seeded.opened}${seeded.seeded}`), '替创建者写进初始项目', seeded);
// 不加 --hide-scrollbars:要量滚动条宽度
// 去掉 Puppeteer 缺省加的 --hide-scrollbars:要量滚动条宽度(加着它滚动条一律 0 宽)
const browser = await puppeteer.launch({ headless: true, ignoreDefaultArgs: ['--hide-scrollbars'], protocolTimeout: 600_000, args: [...PROBE_CHROME_ARGS, '--no-first-run', '--autoplay-policy=no-user-gesture-required'] });
let phone = null;
try {
  /* ================================================================ M1 */
  {
    const p = await env.newPage(browser, 'phone');
    await env.enter(p);
    const r = await p.evaluate(() => ({ mobileUi: !!document.querySelector('[data-pc="mobile-ui"]'), desktopUi: !!document.querySelector('[data-pc="editor"]'), uaMobile: navigator.userAgentData?.mobile ?? null, url: location.pathname + location.search }));
    out.M1.phone = r;
    check(r.mobileUi && !r.desktopUi && r.uaMobile === true, 'M1 安卓仿真进手机版', r);
    phone = p;
  }
  for (const [device, layout, want] of [['desktop', undefined, 'desktop'], ['phone', 'desktop', 'desktop'], ['desktop', 'mobile', 'mobile']]) {
    const p = await env.newPage(browser, device);
    await env.enter(p, { layout });
    await sleep(800);
    const r = await p.evaluate(() => ({ mobileUi: !!document.querySelector('[data-pc="mobile-ui"]'), desktopUi: !!document.querySelector('[data-pc="editor"]'), membersButton: !!document.querySelector('[data-pc="members-button"]'), uaMobile: navigator.userAgentData?.mobile ?? null }));
    out.M1[`${device}${layout ? `+${layout}` : ''}`] = r;
    check(want === 'mobile' ? (r.mobileUi && !r.desktopUi) : (r.desktopUi && !r.mobileUi && r.membersButton), `M1 ${device}${layout ? ` ?layout=${layout}` : ''} → ${want}`, r);
    if (device === 'desktop' && !layout) await shot(p, 'm1-desktop');
    await p.browserContext().close();
  }
  await shot(phone, 'm1-phone');
  const A = phone;
  const phase = (name) => { A.phase = name; };
  const page = () => A.evaluate(() => document.querySelector('[data-pcm="editor"]')?.getAttribute('data-page'));
  const mainIds = () => store(A, `
    const p = S.getState().project;
    const t = [...p.tracks].reverse().find((tr) => tr.clips.some((c) => c.mediaId || c.cutId)) ?? p.tracks[p.tracks.length - 1];
    return t.clips.filter((c) => c.mediaId || c.cutId).sort((a, b) => a.start - b.start).map((c) => c.id);`);
  const noOverflow = async (label) => {
    const w = await A.evaluate(() => ({ doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, pcm: document.querySelector('.pcm')?.scrollWidth ?? 0, vw: innerWidth }));
    out.W[label] = w;
    check(w.doc <= w.vw && w.pcm <= w.vw, `W 375 宽无横向溢出(${label})`, w);
  };
  await noOverflow('empty');

  /* ---------------------------------------------------------------- 内容:经素材库导入三张图、点一下接到主要内容末尾 */
  const imgs = [];
  for (const [i, rgb] of [[1, [200, 60, 50]], [2, [40, 160, 90]], [3, [50, 90, 200]]]) imgs.push(await solidPng(path.join(OUT, `img-${i}.png`), rgb));
  await tap(A, '[data-pcm="sub-image"]');
  await A.waitForSelector('[data-pcm="sheet-assets"]', { visible: true });
  const input = await A.$('[data-pcm="import-input"]');
  await input.uploadFile(...imgs);
  await until('三张图进素材库', async () => (await A.$$('[data-pcm="asset"]')).length >= 3, 60_000, 300);
  await shot(A, 'm2-assets');
  for (let i = 0; i < 3; i++) {
    if (!(await A.$('[data-pcm="sheet-assets"]'))) { await tap(A, '[data-pcm="sub-image"]'); await A.waitForSelector('[data-pcm="asset"]', { visible: true }); }
    await A.evaluate((k) => document.querySelectorAll('[data-pcm="asset"]')[k].scrollIntoView(), i);
    const tiles = await A.$$('[data-pcm="asset"]');
    const r = await tiles[i].boundingBox();
    await A.touchscreen.tap(r.x + r.width / 2, r.y + r.height / 2);
    await sleep(500);
  }
  const ids0 = await until('主要内容有三段', async () => { const ids = await mainIds(); return ids.length === 3 ? ids : null; }, 20_000);
  out.T.initial = ids0;
  check((await A.$$('[data-pcm="mblock"]')).length === 3, 'T 缩略时间轴三张缩略卡');
  await shot(A, 'm2-preview');

  phase('N');
  /* ---------------------------------------------------------------- N 底部导航栏 */
  {
    const items = {};
    for (const k of ['preview', 'timeline', 'agent']) items[k] = await rect(A, `[data-pcm="pg-${k}"]`);
    out.N.items = items;
    check(Object.values(items).every((r) => r && near(r.w, 113, 0.6) && near(r.h, 46, 0.5)), 'N 三项都是 113×46', items);
    const icons = await A.evaluate(() => ['pg-preview', 'pg-timeline'].map((k) => { const r = document.querySelector(`[data-pcm="${k}"] svg`).getBoundingClientRect(); return [r.width, r.height]; })
      .concat([(() => { const r = document.querySelector('[data-pcm="pg-agent"] .disc').getBoundingClientRect(); return [r.width, r.height]; })()]));
    out.N.icons = icons;
    check(icons.every(([w, h]) => near(w, 22, 0.1) && near(h, 22, 0.1)), 'N 三项图标都是 22×22', icons);
    const style = (sel) => A.evaluate((s) => { const e = document.querySelector(s); const c = getComputedStyle(e); return { color: c.color, weight: c.fontWeight, bg: c.backgroundImage, shadow: c.boxShadow }; }, sel);
    const discOff = await style('[data-pcm="pg-agent"] .disc');
    const prevOn = await style('[data-pcm="pg-preview"]');
    out.N.discUnselected = discOff; out.N.previewSelected = prevOn;
    check(/linear-gradient/.test(discOff.bg) && discOff.shadow === 'none', 'N Agent 未选中:渐变实心圆、没有描边', discOff);
    check(prevOn.color === 'rgb(38, 198, 230)' && prevOn.weight === '600', 'N 选中项:青蓝 + 加粗', prevOn);
    await tap(A, '[data-pcm="pg-agent"]');
    await until('切到 Agent 分页', async () => (await page()) === 'agent');
    const discOn = await style('[data-pcm="pg-agent"] .disc');
    const agOn = await style('[data-pcm="pg-agent"]');
    out.N.discSelected = discOn; out.N.agentSelected = agOn;
    check(/linear-gradient/.test(discOn.bg) && /rgb\(38, 198, 230\)/.test(discOn.shadow) && agOn.weight === '600' && agOn.color === 'rgb(38, 198, 230)', 'N Agent 选中:圆不变、外圈青蓝描边、文字青蓝 600', { discOn, agOn });
    const iconsOn = await A.evaluate(() => { const r = document.querySelector('[data-pcm="pg-agent"] .disc').getBoundingClientRect(); return [r.width, r.height]; });
    check(near(iconsOn[0], 22, 0.1) && near(iconsOn[1], 22, 0.1), 'N Agent 选中时圆仍是 22×22(描边向外画)', iconsOn);
    await noOverflow('agent');
    await shot(A, 'm2-agent');
    await tap(A, '[data-pcm="top-back"]');
    await until('「‹」回缩略预览', async () => (await page()) === 'preview');
  }

  phase('T');
  /* ---------------------------------------------------------------- T 缩略卡点选、长按换序 */
  {
    const blocks = async () => A.$$eval('[data-pcm="mblock"]', (bs) => bs.map((b) => ({ id: b.dataset.id, sel: b.classList.contains('sel') })));
    await tap(A, `[data-pcm="mblock"][data-id="${ids0[0]}"]`);
    const b1 = await blocks();
    const sel1 = await store(A, 'return S.getState().selection;');
    out.T.tapSelect = { blocks: b1, selection: sel1, page: await page() };
    check(b1[0].sel && sel1[0] === ids0[0] && (await page()) === 'preview', 'T 点缩略卡 = 原地选中(不切分页)', out.T.tapSelect);
    const first = await text(A, '[data-pcm="subnav-preview"] button');
    out.S.previewFirst = first;
    check(first === '引用', 'S 缩略预览选中后子导航栏第一个是「引用」', first);
    await tap(A, '.mainhead');
    check(!(await blocks()).some((b) => b.sel), 'T 点缩略时间轴以外 = 取消选中');
    // 长按换序:当前帧放到第二段中间(三张卡都在屏幕内),先选中第三张,再按住 450 ms 拖到第一张前面
    await store(A, 'const c = S.getState().project.tracks.flatMap((t) => t.clips).find((x) => x.id === args[0]); S.actions.seek((c.start + c.end) / 2); return true;', ids0[1]);
    await sleep(400);
    out.T.visible = await A.$$eval('[data-pcm="mblock"]', (bs) => bs.map((b) => Math.round(b.getBoundingClientRect().x)));
    await tap(A, `[data-pcm="mblock"][data-id="${ids0[2]}"]`);
    const r3 = await rect(A, `[data-pcm="mblock"][data-id="${ids0[2]}"]`);
    const r1 = await rect(A, `[data-pcm="mblock"][data-id="${ids0[0]}"]`);
    const from = { x: r3.x + r3.w / 2, y: r3.y + r3.h / 2 };
    const to = { x: r1.x + 4, y: from.y };
    await touch(A, lerp(from, to, 12), { holdMs: 450 });
    out.T.afterLift = { page: await page(), toast: await text(A, '[data-pcm="toast"]'), sheet: await A.evaluate(() => [...document.querySelectorAll('[data-pcm^="sheet-"]')].map((e) => e.dataset.pcm)) };
    await shot(A, 'dbg-after-reorder');
    const ids1 = await until('换序落地', async () => { const ids = await mainIds(); return ids[0] === ids0[2] ? ids : null; }, 10_000);
    out.T.reorder = { before: ids0, after: ids1 };
    check(JSON.stringify(ids1) === JSON.stringify([ids0[2], ids0[0], ids0[1]]), 'T 先选中再长按拖动 = 换顺序', out.T.reorder);
    // 只按住拖、没先选中:是滚动,不换序
    await tap(A, '.mainhead');
    const ids1b = await mainIds();
    const ra = await rect(A, `[data-pcm="mblock"][data-id="${ids1b[1]}"]`);
    /*
     * 这一下要同时判两件事,原来只判了后一件:
     *   ① 手指划过去,缩略时间轴**真的滚动了**;
     *   ② 没先选中时按住拖只是滚动,不换序。
     * 只判 ② 的话,一条「手指划了什么都不动」的时间轴照样能过 —— 用户 2026-10-24 报的
     * 「手机版传统式缩略时间轴用触屏没法滑动查看」就是从这个缝里漏过去的。
     * `.strip-scroll` 上写着 `touch-action: none`,浏览器原生滑动是关掉的,全靠
     * `ThumbStrip` 的 onPointerDown 手动改 scrollLeft,所以这条路必须有人盯。
     */
    const slBefore = await A.$eval('.strip-scroll', (el) => el.scrollLeft);
    await touch(A, lerp({ x: ra.x + ra.w / 2, y: ra.y + ra.h / 2 }, { x: ra.x - 60, y: ra.y + ra.h / 2 }, 8), { holdMs: 450 });
    const slAfter = await A.$eval('.strip-scroll', (el) => el.scrollLeft);
    /*
     * 本来还想判「松手之后还带惯性继续滑」—— 那正是这次改动的要害(原生横滑有惯性,
     * 手动推 scrollLeft 那条老路没有)。实测判不了:CDP 的 `Input.dispatchTouchEvent` 是合成触点,
     * 不触发合成器的抛掷动画,改之后量出来 rest 仍然等于 after。所以这里只判「真的滚动了」,
     * 惯性那一条**在这套无头环境里证不了**,要真机才算数。
     */
    out.T.touchScroll = { before: Math.round(slBefore), after: Math.round(slAfter) };
    check(slAfter - slBefore > 20, 'T 手指往左划,缩略时间轴跟着滚动', out.T.touchScroll);
    check(JSON.stringify(await mainIds()) === JSON.stringify(ids1b), 'T 没选中时按住拖动只是滚动,不换序');
    /*
     * 只剩**一段**时也要能从头滑到尾（用户 2026-10-24 在 iPhone 上报：一段 6 秒的项目，
     * 手指划缩略条白线一动不动）。原来这支探针一直用三段的项目，这种情形从没测过。
     * 两件事一起判：划得动，而且**松手之后不会被弹回去** —— 同步「滚动位置 ← 当前时间」
     * 那个 effect 每次渲染都跑，惯性那一段 dragging 已经是 false，不挡住它就会把人划的距离吃掉。
     */
    // 用正经的 removeClip 删掉其余两段（不原地改 store 里的项目对象，那是仓库的硬约束）
    for (const id of ids1b.slice(1)) await store(A, 'S.actions.removeClip(args[0]); return true;', id).catch(() => null);
    await sleep(600);
    const oneIds = await mainIds();
    out.T.oneClip = { ids: oneIds };
    if (oneIds.length === 1) {
      const geo = await A.$eval('.strip-scroll', (el) => ({ client: el.clientWidth, scroll: el.scrollWidth }));
      out.T.oneClip.geo = geo;
      check(geo.scroll - geo.client > 20, 'T 只剩一段时缩略条仍有可滚的余量（左右占位要留够）', geo);
      const r1 = await rect(A, `[data-pcm="mblock"][data-id="${oneIds[0]}"]`);
      // 先把滚动位置摆到中间，两个方向才都有余量可走（在端点上往外划本来就不该动）
      await A.$eval('.strip-scroll', (el) => { el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2; });
      await sleep(500);
      const mid = await A.$eval('.strip-scroll', (el) => el.scrollLeft);
      const swipe = async (dx) => {
        const from = await A.$eval('.strip-scroll', (el) => el.scrollLeft);
        const cy = r1.y + r1.h / 2, cx = r1.x + r1.w / 2;
        await touch(A, lerp({ x: cx, y: cy }, { x: cx + dx, y: cy }, 8));
        const to = await A.$eval('.strip-scroll', (el) => el.scrollLeft);
        await sleep(900);
        const rest = await A.$eval('.strip-scroll', (el) => el.scrollLeft);
        return { from: Math.round(from), to: Math.round(to), rest: Math.round(rest) };
      };
      const left = await swipe(-35);
      await A.$eval('.strip-scroll', (el) => { el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2; });
      await sleep(500);
      const right = await swipe(35);
      out.T.oneClip.scroll = { mid: Math.round(mid), 往左划: left, 往右划: right };
      check(left.to - left.from > 5, 'T 只剩一段时往左划，缩略条跟着动', left);
      check(right.from - right.to > 5, 'T 只剩一段时往右划，缩略条跟着动', right);
      check(Math.abs(left.rest - left.to) < 8 && Math.abs(right.rest - right.to) < 8,
        'T 松手之后不被弹回去（同步 effect 不跟用户抢）', out.T.oneClip.scroll);
    } else {
      check(false, 'T 没能把项目裁成一段，这一组没测到', out.T.oneClip);
    }
    // 把删掉的两段撤销回来：后面还要用两段之间的「＋」加转场
    for (let i = 0; i < 6 && (await mainIds()).length < ids1b.length; i++) {
      await store(A, 'S.actions.undo(); return true;').catch(() => null);
      await sleep(250);
    }
    out.T.oneClip.restored = (await mainIds()).length;
    check(out.T.oneClip.restored === ids1b.length, 'T 撤销之后三段都回来了（后面几步要用）', out.T.oneClip.restored);
    await A.$eval('.strip-scroll', (el) => { el.scrollLeft = 0; });
    await sleep(300);
    // 加转场:点两段之间的 ＋ → 卡片库转场分类 → 交叉溶解
    await A.evaluate(() => { const sc = document.querySelector('.strip-scroll'); sc.scrollLeft = 0; });
    await sleep(200);
    await tap(A, '[data-pcm="mark-add"]');
    await A.waitForSelector('[data-pcm="sheet-cards"]', { visible: true });
    out.T.cardsHint = await text(A, '[data-pcm="cards-hint"]');
    await tap(A, '[data-pcm="transition-kind"][data-kind="crossfade"]');
    await until('◇ 出现', () => A.$('[data-pcm="mark"]'), 10_000);
    const trCount = await store(A, 'return (S.getState().project.transitions ?? []).length;');
    check(trCount === 1, 'T ＋ → 转场分类 → 加上交叉溶解', trCount);
    await tap(A, '[data-pcm="mark"]');
    const markSel = await A.$eval('[data-pcm="mark"]', (m) => m.classList.contains('sel'));
    const sub = await A.$$eval('[data-pcm="subnav-preview"] button', (bs) => bs.map((b) => b.textContent.trim()));
    out.T.markTap = { markSel, page: await page(), subnav: sub };
    check(markSel && (await page()) === 'preview' && sub[0] === '引用' && sub.includes('换转场') && sub.includes('时长·强度'), 'T 点 ◇ = 原地选中转场,子导航栏「引用、时长·强度、换转场、删除」', out.T.markTap);
    await shot(A, 'm2-transition-selected');
    await tap(A, '.mainhead');
  }

  phase('S');
  /* ---------------------------------------------------------------- S 子导航栏两页同高同位 + Z 完整时间轴 */
  {
    const sPrev = await rect(A, '[data-pcm="subnav-preview"]');
    await tap(A, '[data-pcm="pg-timeline"]');
    await until('切到时间轴分页', async () => (await page()) === 'timeline');
    await sleep(400);
    const sTl = await rect(A, '[data-pcm="subnav-timeline"]');
    out.S.rects = { preview: sPrev, timeline: sTl };
    check(sPrev && sTl && near(sPrev.y, sTl.y) && near(sPrev.h, 66, 0.5) && near(sTl.h, 66, 0.5) && near(sPrev.x, sTl.x) && near(sPrev.w, sTl.w), 'S 子导航栏两页同高(66)同位', out.S.rects);
    const px = () => A.$eval('.tl-inner', (e) => Number(e.dataset.px));
    const sc = () => A.$eval('[data-pcm="tl-scroll"]', (e) => ({ sl: e.scrollLeft, cw: e.clientWidth, left: e.getBoundingClientRect().left }));
    const total = await store(A, 'const p = S.getState().project; return Math.max(p.duration, ...p.tracks.flatMap((t) => t.clips.map((c) => c.end)), 1);');
    const fitPx = await px();
    const s0 = await sc();
    const want = Math.max(6, Math.min(120, (s0.cw - 30 - 12) / total));
    out.Z.fit = { px: fitPx, want, total, clientWidth: s0.cw };
    check(near(fitPx, want, 0.01) && s0.sl === 0, 'Z 进入时间轴默认「适应宽度」', out.Z.fit);
    await store(A, 'S.actions.seek(args[0]); return true;', total * 0.4);
    await sleep(300);
    const ph0 = await rect(A, '[data-pcm="playhead"]');
    await tap(A, '[data-pcm="zoom-in"]');
    await sleep(300);
    const px1 = await px(), ph1 = await rect(A, '[data-pcm="playhead"]');
    out.Z.zoomIn = { px0: fitPx, px1, ph0: ph0.x, ph1: ph1.x };
    check(near(px1, Math.min(120, fitPx * 1.25), 0.01) && near(ph0.x, ph1.x, 1.5), 'Z ＋ 每次 1.25 倍、以播放头为中心', out.Z.zoomIn);
    await tap(A, '[data-pcm="zoom-out"]');
    await sleep(300);
    const px2 = await px(), ph2 = await rect(A, '[data-pcm="playhead"]');
    out.Z.zoomOut = { px2, ph2: ph2.x };
    check(near(px2, fitPx, 0.01) && near(ph2.x, ph0.x, 1.5), 'Z − 以播放头为中心缩回', out.Z.zoomOut);
    // 双指捏合:两个触点落在一段片段上张开,比例跟着距离变、以两指中点为中心,不选中、不动播放头
    await store(A, 'S.actions.select([]); return true;');
    const tBefore = await store(A, 'return S.getState().t;');
    const lane = await rect(A, '.lane .clip');
    const mid = { x: lane.x + Math.min(lane.w, 120) / 2 + 20, y: lane.y + lane.h / 2 };
    const s1 = await sc();
    const tAtMid0 = (s1.sl + mid.x - s1.left - 30) / fitPx;
    const steps = Array.from({ length: 11 }, (_, i) => { const d = 30 + 30 * i / 10; return [{ x: mid.x - d, y: mid.y }, { x: mid.x + d, y: mid.y }]; });
    await touch(A, steps);
    await sleep(400);
    const pxP = await px(), s2 = await sc();
    const tAtMid1 = (s2.sl + mid.x - s2.left - 30) / pxP;
    const selP = await store(A, 'return S.getState().selection;');
    const tAfter = await store(A, 'return S.getState().t;');
    out.Z.pinch = { px0: fitPx, px1: pxP, ratio: pxP / fitPx, tAtMid0, tAtMid1, selection: selP, t: [tBefore, tAfter] };
    check(near(pxP / fitPx, Math.min(120 / fitPx, 2), 0.08), 'Z 双指捏合:比例 = 两指距离之比', out.Z.pinch);
    check(near(tAtMid0, tAtMid1, 0.05), 'Z 双指捏合以两指中点为中心', out.Z.pinch);
    check(selP.length === 0 && near(tBefore, tAfter, 1e-6), 'Z 捏合时不选中片段、不移动播放头', out.Z.pinch);
    await shot(A, 'm2-timeline-pinched');
    // 横向滚动条:放大到头
    for (let i = 0; i < 20 && !(await A.$eval('[data-pcm="zoom-in"]', (b) => b.disabled)); i++) await tap(A, '[data-pcm="zoom-in"]');
    out.R.horizontal = await A.$eval('[data-pcm="tl-scroll"]', (e) => ({ px: Number(document.querySelector('.tl-inner').dataset.px), diff: e.offsetHeight - e.clientHeight }));
    check(out.R.horizontal.px === 120, 'Z 时间轴放大到上限 120 后「＋」禁用', out.R.horizontal);
    await tap(A, '[data-pcm="zoom-fit"]');
    await sleep(300);
    check(near(await px(), fitPx, 0.01), 'Z 「适应宽度」回到整段放进可见宽度');
    // 时间轴里选中片段:第一个是「引用」
    const clipR = await rect(A, '.lane .clip');
    await A.touchscreen.tap(clipR.x + Math.min(clipR.w, 40) / 2, clipR.y + clipR.h / 2);
    await sleep(300);
    const tlFirst = await A.$$eval('[data-pcm="subnav-timeline"] button', (bs) => bs.map((b) => b.textContent.trim()));
    out.S.timelineSelected = tlFirst;
    check(tlFirst[0] === '引用', 'S 时间轴选中片段后子导航栏第一个是「引用」', tlFirst);
    await noOverflow('timeline');
    await shot(A, 'm2-timeline');
  }

  phase('B');
  /* ---------------------------------------------------------------- B 返回层级与浏览器后退 */
  {
    await A.goBack();
    const p1 = await until('后退:时间轴 → 缩略预览', async () => ((await page()) === 'preview' ? 'preview' : null), 5000);
    for (const k of ['timeline', 'agent', 'timeline', 'agent']) { await tap(A, `[data-pcm="pg-${k}"]`); await sleep(150); }
    const atAgent = await page();
    await A.goBack();
    const p2 = await until('分页之间切了几次,后退一次仍回缩略预览', async () => ((await page()) === 'preview' ? 'preview' : null), 5000);
    await tap(A, '[data-pcm="pg-timeline"]');
    await tap(A, '[data-pcm="tl-done"]');
    const p3 = await page();
    out.B = { timelineBack: p1, switchedThenBack: { atAgent, after: p2 }, doneButton: p3 };
    check(p1 === 'preview' && atAgent === 'agent' && p2 === 'preview' && p3 === 'preview', 'B 分页 → 缩略预览(浏览器后退、✓)', out.B);
  }

  phase('R');
  /* ---------------------------------------------------------------- R 竖向滚动条 + 面板 */
  {
    await tap(A, '[data-pcm="sub-card"]');
    await A.waitForSelector('[data-pcm="sheet-cards"] .sheet-body', { visible: true });
    await sleep(400);
    out.R.phoneOverlay = await A.$eval('[data-pcm="sheet-cards"] .sheet-body', (e) => ({ diff: e.offsetWidth - e.clientWidth, scrollable: e.scrollHeight > e.clientHeight }));
    await noOverflow('cards-sheet');
    await shot(A, 'm2-cards');
    // 三档拖动:按住横杠往上拖 = 展开,往下拖过一定距离 = 关闭
    const g = await center(A, '[data-pcm="sheet-cards"] [data-pcm="grip"]');
    const h0 = (await rect(A, '[data-pcm="sheet-cards"]')).h;
    await touch(A, lerp(g, { x: g.x, y: g.y - 150 }, 10));
    await sleep(300);
    const h1 = (await rect(A, '[data-pcm="sheet-cards"]')).h;
    const g2 = await center(A, '[data-pcm="sheet-cards"] [data-pcm="grip"]');
    await touch(A, lerp(g2, { x: g2.x, y: g2.y + 600 }, 12));
    await sleep(500);
    const closed = !(await A.$('[data-pcm="sheet-cards"]'));
    out.R.sheetDrag = { h0, expanded: h1, closed };
    check(h1 > h0 + 60 && closed, '面板往上拖展开、往下拖关闭', out.R.sheetDrag);
    for (const [sel, name] of [['[data-pcm="members-btn"]', 'm2-members'], ['[data-pcm="top-export"]', 'm2-export'], ['[data-pcm="sub-cut"]', 'm2-cuts']]) {
      await tap(A, sel);
      await sleep(500);
      await noOverflow(name);
      await shot(A, name);
      await tap(A, '[data-pcm="scrim"]');
      await sleep(300);
    }
  }

  /* ---------------------------------------------------------------- R 滚动条宽度:手机仿真下 Chrome 用悬浮滚动条(不占宽度),
     所以照演示稿第十一轮的量法,在 --headless=new 的桌面 Chromium 里开 375×812、?layout=mobile 量 */
  {
    const P = await env.newPage(browser, 'none');
    await P.setViewport({ width: 375, height: 812 });
    await env.enter(P, { layout: 'mobile', username: 'sb' });
    await P.click('[data-pcm="pg-timeline"]');
    await P.waitForSelector('[data-pcm="tl-scroll"]', { visible: true });
    for (let i = 0; i < 20 && !(await P.$eval('[data-pcm="zoom-in"]', (b) => b.disabled)); i++) { await P.click('[data-pcm="zoom-in"]'); await sleep(120); }
    out.R.horizontal = await P.$eval('[data-pcm="tl-scroll"]', (e) => ({ diff: e.offsetHeight - e.clientHeight, scrollable: e.scrollWidth > e.clientWidth }));
    check(out.R.horizontal.scrollable && out.R.horizontal.diff === 5, 'R 完整时间轴横向滚动条 offsetHeight - clientHeight = 5', out.R.horizontal);
    await P.click('[data-pcm="tl-done"]');
    await sleep(300);
    await P.click('[data-pcm="sub-card"]');
    await P.waitForSelector('[data-pcm="sheet-cards"] .sheet-body', { visible: true });
    await sleep(400);
    out.R.vertical = await P.$eval('[data-pcm="sheet-cards"] .sheet-body', (e) => ({ diff: e.offsetWidth - e.clientWidth, scrollable: e.scrollHeight > e.clientHeight, thumb: getComputedStyle(e, '::-webkit-scrollbar-thumb').backgroundColor }));
    check(out.R.vertical.scrollable && out.R.vertical.diff === 5, 'R 底部面板竖向滚动条 offsetWidth - clientWidth = 5', out.R.vertical);
    await P.screenshot({ path: path.join(OUT, 'm2-scrollbar.png') });
    await P.browserContext().close();
  }

  phase('C');
  /* ---------------------------------------------------------------- C 冲突横条(两名成员,只断甲) */
  {
    const B = await env.newPage(browser, 'phone');
    await env.enter(B, { via: 2, username: 'yi' });
    const ids = await mainIds();
    const errsBefore = A.consoleErrors.length;
    env.proxy.cutWs();
    await sleep(1000);
    await store(A, 'S.actions.updateClip(args[0], { opacity: 0.5 }); return true;', ids[1]);
    // 等甲真的判成离线(会话接续期间不算):常驻提示「当前离线，有未提交的修改」出现
    const unsent = await until('甲判成离线且有未提交的修改', () => A.$('[data-pc="offline-unsent"]'), 150_000, 500);
    out.C.offlineUnsent = !!unsent;
    await store(B, 'S.actions.updateClip(args[0], { opacity: 0.8 }); return true;', ids[1]);
    await sleep(2000);
    env.proxy.blockWs = false;
    const bar = await until('甲的冲突横条出现', () => A.$('[data-pcm="cfbar"]'), 120_000, 500);
    if (bar) {
      const top = await rect(A, '[data-pcm="topbar"]');
      const cf = await rect(A, '[data-pcm="cfbar"]');
      out.C.bar = { text: await text(A, '[data-pcm="cfbar-text"]'), topbarBottom: top.y + top.h, cfTop: cf.y, cfH: cf.h, sheetOpen: !!(await A.$('[data-pcm="sheet-conflict"]')) };
      check(near(cf.y, top.y + top.h + 2, 1.5) && near(cf.h, 36, 0.5) && /\d+ 处改动待合并/.test(out.C.bar.text), 'C 冲突横条在顶栏正下方', out.C.bar);
      await shot(A, 'm2-conflict');
      if (!(await A.$('[data-pcm="sheet-conflict"]'))) await tap(A, '[data-pcm="cfbar-open"]');
      // 进项目时的气泡可能盖住「处理」:点不着就直接点元素
      if (!(await A.$('[data-pcm="sheet-conflict"]'))) await A.evaluate(() => document.querySelector('[data-pcm="cfbar-open"]')?.click());
      await A.waitForSelector('[data-pcm="sheet-conflict"]', { visible: true });
      await shot(A, 'm2-conflict-sheet');
      // 2026-10-22 起面板是逐项勾选(同桌面「冲突合并」):「删除选中」没勾时是灰的,先勾上一级再删(原来是整份「删除全部」,点了就清)
      out.C.dropBeforeSelect = await A.evaluate(() => document.querySelector('[data-pcm="cf-drop"]')?.disabled ?? null);
      check(out.C.dropBeforeSelect === true, 'C 没勾选时「删除选中」是灰的', out.C.dropBeforeSelect);
      await A.evaluate(() => { for (const i of document.querySelectorAll('[data-pcm="cf-thing"] .cf-head input')) if (!i.checked) i.click(); });
      await sleep(300);
      await tap(A, '[data-pcm="cf-drop"]');
      out.C.closeText = await until('删除选中后关闭按钮变「完成」', () => A.evaluate(() => document.querySelector('[data-pcm="cf-close"]')?.textContent?.trim() === '完成' ? '完成' : null), 10_000);
      await A.evaluate(() => document.querySelector('[data-pcm="cf-close"]')?.click());
      const gone = await until('处理完横条收起', async () => !(await A.$('[data-pcm="cfbar"]')), 30_000);
      const pane = await rect(A, '[data-pcm="pane-preview"]'), pager = await rect(A, '[data-pcm="pager"]');
      out.C.after = { gone: !!gone, paneBottom: pane.y + pane.h, pagerTop: pager.y };
      check(!!gone && near(pane.y + pane.h, pager.y, 1), 'C 处理完横条收起,缩略时间轴仍贴底', out.C.after);
    }
    out.C.wsErrorsWhileCut = A.consoleErrors.slice(errsBefore).filter((e) => /WebSocket connection to .*\/hosted/.test(e)).length;
    A.consoleErrors = A.consoleErrors.filter((e, i) => i < errsBefore || !/WebSocket connection to .*\/hosted/.test(e));
    await B.browserContext().close();
  }

  phase('home');
  /* ---------------------------------------------------------------- B 主页 → 项目列表(最后做:离开项目) */
  {
    await tap(A, '[data-pcm="top-home"]');
    const home = await until('主页回项目列表', () => A.$('[data-pcm="home"]'), 10_000);
    out.B.home = !!home;
    check(!!home, 'B 缩略预览左上角主页 → 项目列表');
    await noOverflow('home');
    await shot(A, 'm2-home');
  }

  /* ---------------------------------------------------------------- W 控制台 */
  out.W.pageErrors = A.errors;
  // 本机测试环境没有网站账号服务(项目是凭口令的共享项目):回开始页时查登录的 /api/account/me 回 404,生产上有这个接口,单独列出不算页面报错
  // 社区版的在线构建没有接口守卫(闭源),上传队列的目标查询会真发出去,也回 404
  const accountMissing = (e) => /\/api\/(?:account|media\/upload-queue)\//.test(e);
  out.W.badResponses = A.badResponses;
  out.W.accountApiMissingInLocalEnv = A.badResponses.filter(accountMissing);
  let skip404 = A.badResponses.filter((r) => r.startsWith('404 ') && accountMissing(r)).length;
  A.consoleErrors = A.consoleErrors.filter((e) => { if (skip404 > 0 && /status of 404/.test(e)) { skip404--; return false; } return true; });
  out.W.consoleErrors = A.consoleErrors;
  check(A.errors.length === 0, 'W 页面没有未捕获的错误', A.errors);
  check(A.consoleErrors.length === 0, 'W 控制台没有报错', A.consoleErrors);

  /* ---------------------------------------------------------------- 演示稿同尺寸截图,并排(演示稿在 prototypes/,社区版没有) */
  if (fs.existsSync(DEMO)) {
    const D = await env.newPage(browser, 'phone');
    await D.goto(pathToFileURL(DEMO).href, { waitUntil: 'load' });
    const demoShot = async (name) => { await sleep(300); await D.screenshot({ path: path.join(OUT, `demo-${name}.png`) }); };
    await demoShot('home');
    await D.evaluate(() => openProject('p1'));
    await demoShot('preview');
    await D.evaluate(() => pageTimeline());
    await sleep(300);
    await demoShot('timeline');
    await D.evaluate(() => pageAgent());
    await demoShot('agent');
    await D.evaluate(() => { pagePreview(); openSheet('cards'); });
    await demoShot('cards');
    await D.evaluate(() => { closeSheets(); openSheet('conflict'); });
    await demoShot('conflict-sheet');
    for (const [mine, demo] of [['m2-home', 'home'], ['m2-preview', 'preview'], ['m2-timeline', 'timeline'], ['m2-agent', 'agent'], ['m2-cards', 'cards'], ['m2-conflict-sheet', 'conflict-sheet']]) {
      const a = path.join(OUT, `${mine}.png`), b = path.join(OUT, `demo-${demo}.png`);
      if (fs.existsSync(a) && fs.existsSync(b)) sideBySide(a, b, path.join(OUT, `side-${demo}.png`));
    }
    out.sides = fs.readdirSync(OUT).filter((f) => f.startsWith('side-'));
  }
} catch (e) {
  fails.push(`探针异常:${e?.stack ?? e}`);
} finally {
  out.ok = fails.length === 0;
  out.fails = fails;
  await browser.close().catch(() => {});
  await env.close();
  console.log(JSON.stringify(out));
  process.exit(out.ok ? 0 : 1);
}
