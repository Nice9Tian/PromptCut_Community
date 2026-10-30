// First import protects user directories and the shared port file before any fixture import.
import '../lib/no-user-dirs.mjs';
/**
 * 氛围式「详细编辑」里舞台和时间轴之间那条能拖的缝的验收探针（issue #40，用户 2026-10-26 提）。
 *
 * 跑的是**真页面**：本机桌面版那一条路（`/?ui=vibe` → 新建本机项目 → 聊天页 → 拓展栏「画面」→「详细编辑」），
 * 真舞台 iframe、真时间轴，不接云端、不接账号。开发服务由调用方先起好，探针只连它：
 *
 *   PROMPTCUT_NO_PORT_FILE=1 PROMPTCUT_PROJECTS_DIR=<临时目录> npx vite --port 5203 --strictPort --host 127.0.0.1
 *   node scripts/probes/vibe-detail-grip-probe.mjs [--origin http://127.0.0.1:5203] [--out <截图目录>]
 *
 * 页面带 `?nosetup=1`:本机没配 Agent 时首启会弹「配置 Agent」那个模态框,它盖住整页、鼠标点不到缝。
 *
 * 开发服务另占「端口 +1」「端口 +2」当舞台端口（`guide_files/verification.md`「验证环境」）。
 * `PROMPTCUT_PROJECTS_DIR` 给个临时目录：探针会在里面建一个空项目，不设就落在仓库的 `.pc-projects/`。
 *
 * 验收（每项一行进最后那行 JSON 的 `fails`）：
 *   G1 缝在传输控件和时间轴之间：`[data-pc="start-detail-grip"]` 在，`role=separator`、`aria-orientation=horizontal`、
 *      能 Tab 到（tabindex=0）；它的下沿贴着时间轴的上沿，上沿在那排传输控件下面。
 *   G2 平时不画线，鼠标压上来才亮：静止时那条线 `opacity: 0`，hover 之后 `opacity: 1`。
 *   G3 拖得动：往上拖 120px，时间轴高 +120（±3），上面的舞台跟着矮下去，页面不纵向溢出。
 *   G4 记在本机：松手后 `pc.start.detailTlH` 就是拖出来的高；收起详细编辑再打开，还是这个高。
 *   G5 双击复位：双击那条缝，回到没拖过时 CSS 给的默认高，本机那一条被删掉。
 *   G6 键盘也能调：聚焦那条缝，ArrowUp 四下 +32，Shift+ArrowDown 一下 −32（上去是变高，和拖的方向一致）。
 *   G7 拖到头有界：往上拖 2000px 顶多到这一页的七成（舞台还剩得下），往下拖 2000px 不低于 160px。
 * 截图：`grip-default.png`、`grip-hover.png`、`grip-tall.png`、`grip-short.png`。
 * 最后一行是一行 JSON：{ ok, fails, ... }。退出码 0 过、1 不过。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';

setTimeout(() => { console.error('SCRIPT_TIMEOUT'); process.exit(124); }, 10 * 60_000).unref();

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const ORIGIN = arg('--origin', 'http://127.0.0.1:5203');
const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), 'vibe-detail-grip-shots')));
fs.mkdirSync(OUT, { recursive: true });

/** 这一页七成高是拖杆的上限（`DetailEdit.tsx` 的 TL_MAX_RATIO），最矮 160（TL_MIN_H） */
const MAX_RATIO = 0.7;
const MIN_H = 160;
const KEY = 'pc.start.detailTlH';

const fails = [];
const out = { ok: false, out: OUT, origin: ORIGIN };
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 400))); return !!cond; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ headless: 'new', args: [...PROBE_CHROME_ARGS, '--window-size=1440,980'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 980 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });

const sel = (pc) => `[data-pc="${pc}"]`;
const click = async (pc) => { await page.waitForSelector(sel(pc), { timeout: 60_000 }); await page.click(sel(pc)); };

/** 详细编辑这一页的几何：时间轴、舞台、那条缝、整页 */
const geo = () => page.evaluate(() => {
  const r = (pc) => { const el = document.querySelector(`[data-pc="${pc}"]`); if (!el) return null; const b = el.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height) }; };
  const transport = (() => { const el = document.querySelector('.ps-detail-transport'); if (!el) return null; const b = el.getBoundingClientRect(); return { bottom: Math.round(b.bottom) }; })();
  return {
    tl: r('start-detail-tl'), stage: r('start-detail-stage'), grip: r('start-detail-grip'), root: r('start-detail'), transport,
    saved: (() => { try { return localStorage.getItem('pc.start.detailTlH'); } catch { return null; } })(),
    overflowY: Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
  };
});

const gripCenter = async () => {
  const b = await page.$eval(sel('start-detail-grip'), (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  return b;
};
/** 从缝上按下去，往上（dy<0）或往下拖 dy 像素 */
const drag = async (dy) => {
  const { x, y } = await gripCenter();
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + dy, { steps: 14 });
  await page.mouse.up();
  await sleep(150);
};

try {
  /* ── 真页面：新建一个本机项目，进聊天页 ── */
  await page.goto(`${ORIGIN}/?ui=vibe&nosetup=1`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await click('start-side-new');
  await page.waitForSelector(sel('start-ext-detail'), { timeout: 60_000 });
  await sleep(1200);

  /* ── 进详细编辑 ── */
  await click('start-ext-detail');
  await page.waitForSelector(sel('start-detail-tl'), { timeout: 60_000 });
  await sleep(600);
  const g0 = await geo();
  await page.screenshot({ path: path.join(OUT, 'grip-default.png') });

  /* G1 缝在传输控件和时间轴之间 */
  const a11y = await page.$eval(sel('start-detail-grip'), (el) => ({
    role: el.getAttribute('role'), orient: el.getAttribute('aria-orientation'),
    tabindex: el.getAttribute('tabindex'), title: el.getAttribute('title'), h: Math.round(el.getBoundingClientRect().height),
  }));
  out.G1 = { ...a11y, gripBottom: g0.grip?.bottom, tlTop: g0.tl?.top, transportBottom: g0.transport?.bottom, defaultH: g0.tl?.h };
  check(!!g0.grip, 'G1 没有那条缝');
  check(a11y.role === 'separator' && a11y.orient === 'horizontal', 'G1 role / aria-orientation 不对', a11y);
  check(a11y.tabindex === '0', 'G1 Tab 不到那条缝', a11y);
  check(g0.grip && g0.tl && near(g0.grip.bottom, g0.tl.top, 1), 'G1 缝的下沿没贴着时间轴的上沿', out.G1);
  check(g0.grip && g0.transport && g0.grip.top >= g0.transport.bottom - 1, 'G1 缝没落在传输控件下面', out.G1);

  /* G2 平时不画线，压上来才亮 */
  const lineOpacity = () => page.$eval(sel('start-detail-grip'), (el) => getComputedStyle(el, '::after').opacity);
  const idleOpacity = await lineOpacity();
  const c = await gripCenter();
  await page.mouse.move(c.x, c.y);
  await sleep(250);
  const hoverOpacity = await lineOpacity();
  await page.screenshot({ path: path.join(OUT, 'grip-hover.png') });
  out.G2 = { idle: idleOpacity, hover: hoverOpacity };
  check(Number(idleOpacity) === 0, 'G2 没拖的时候那条线就亮着', out.G2);
  check(Number(hoverOpacity) === 1, 'G2 鼠标压上来那条线没亮', out.G2);

  /* G3 拖得动 */
  await drag(-120);
  const g1 = await geo();
  out.G3 = { before: { tl: g0.tl?.h, stage: g0.stage?.h }, after: { tl: g1.tl?.h, stage: g1.stage?.h }, overflowY: g1.overflowY };
  check(near(g1.tl.h, g0.tl.h + 120, 3), 'G3 往上拖 120px，时间轴没高 120', out.G3);
  check(g1.stage.h < g0.stage.h, 'G3 时间轴高起来了，上面的舞台没跟着矮下去', out.G3);
  check(g1.overflowY === 0, 'G3 拖完页面纵向溢出了', out.G3);
  await page.screenshot({ path: path.join(OUT, 'grip-tall.png') });

  /* G4 记在本机，收起再打开还是这个高 */
  const dragged = g1.tl.h;
  check(Number(g1.saved) === dragged, 'G4 松手没把高度记进本机', { saved: g1.saved, dragged });
  await click('start-detail-close');
  await sleep(400);
  await click('start-ext-detail');
  await page.waitForSelector(sel('start-detail-tl'), { timeout: 30_000 });
  await sleep(500);
  const g2 = await geo();
  out.G4 = { saved: g1.saved, dragged, reopened: g2.tl?.h };
  check(near(g2.tl.h, dragged, 2), 'G4 收起再打开，时间轴没回到拖出来的高', out.G4);

  /* G5 双击复位 */
  const c2 = await gripCenter();
  // 浏览器按 clickCount 认双击:要一下一下按,第二下带 clickCount:2,才会发出 dblclick(`page.mouse.click` 两下不算)
  await page.mouse.move(c2.x, c2.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.up({ clickCount: 2 });
  await sleep(400);
  const g3 = await geo();
  out.G5 = { reset: g3.tl?.h, defaultH: g0.tl?.h, saved: g3.saved };
  check(near(g3.tl.h, g0.tl.h, 2), 'G5 双击没回到默认高', out.G5);
  check(g3.saved === null, 'G5 双击之后本机那一条还在', out.G5);

  /* G6 键盘 */
  await page.focus(sel('start-detail-grip'));
  for (let i = 0; i < 4; i += 1) await page.keyboard.press('ArrowUp');
  await sleep(300);
  const g4 = await geo();
  await page.keyboard.down('Shift');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.up('Shift');
  await sleep(300);
  const g5 = await geo();
  out.G6 = { base: g3.tl?.h, up4: g4.tl?.h, shiftDown1: g5.tl?.h, saved: g5.saved };
  check(near(g4.tl.h, g3.tl.h + 32, 2), 'G6 方向键上四下没加 32', out.G6);
  check(near(g5.tl.h, g4.tl.h - 32, 2), 'G6 Shift + 方向键下一下没减 32', out.G6);
  check(Number(g5.saved) === g5.tl.h, 'G6 键盘调完没记进本机', out.G6);

  /* G7 拖到头有界 */
  await drag(-2000);
  const g6 = await geo();
  await page.screenshot({ path: path.join(OUT, 'grip-tall-max.png') });
  await drag(2000);
  const g7 = await geo();
  await page.screenshot({ path: path.join(OUT, 'grip-short.png') });
  out.G7 = { rootH: g6.root?.h, maxTl: g6.tl?.h, cap: Math.round((g6.root?.h ?? 0) * MAX_RATIO), minTl: g7.tl?.h, stageAtMax: g6.stage?.h };
  check(g6.tl.h <= Math.round(g6.root.h * MAX_RATIO) + 2, 'G7 往上拖过了这一页的七成', out.G7);
  check(g6.stage.h > 0, 'G7 拖到头把舞台挤没了', out.G7);
  check(near(g7.tl.h, MIN_H, 2), 'G7 往下拖没停在最矮 160px', out.G7);

  out.errors = errors;
  check(errors.length === 0, ' 页面有报错', errors.slice(0, 3));
} catch (e) {
  fails.push(`跑崩了: ${String(e).slice(0, 300)}`);
} finally {
  await browser.close().catch(() => {});
}

out.fails = fails;
out.ok = fails.length === 0;
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
