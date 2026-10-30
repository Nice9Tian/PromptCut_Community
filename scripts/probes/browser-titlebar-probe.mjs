import '../lib/no-user-dirs.mjs';
/**
 * 浏览器版不画应用标题栏(2026-10-22 用户定:不要「显示顶部菜单栏」和 − □ × 三个按钮;桌面版照旧)的探针。
 * 用无头 Chrome 各开一个编辑器页面,看真实 DOM,不靠读源码:
 *
 *   node scripts/probes/browser-titlebar-probe.mjs [--online-port 5960] [--desktop-port 5963] [--out out/browser-titlebar]
 *
 * 自己起两台开发服务(`PROMPTCUT_NO_PORT_FILE=1`,不写公共端口文件;端口各占「端口 +1」「+2」当舞台端口,三个连号要空着):
 *   - 在线:`vite --mode online`(编译期常量 `VITE_PC_ONLINE=1`),开 `/?editor`;
 *   - 桌面:`vite`(缺省模式),开 `/?editor`。
 *
 * 检查(每项一行 JSON `{ check, ok, ... }`,最后一行 `{ summary }`;有失败退出码 1):
 *   O1 在线:编辑器顶栏在(`.pc-bar--main`),页面上没有 `.pc-titlebar`、`.pc-titlebar-menus`、`.pc-titlebar-window-controls`、
 *      `.pc-window-control`,也没有应用菜单(`nav[aria-label="应用菜单"]`)里的按钮。
 *   O2 在线:没有空占位——编辑器顶栏贴在页面最上沿(顶边 y = 0)。
 *   O3 在线:顶栏「⋯」菜单里有:皮肤…、快捷键、关于 PromptCut;点「快捷键」「关于 PromptCut」各弹一次说明(dialog 文字对得上)。
 *   O4 在线:另五项的入口都在顶栏上:撤销、重做、首页、导出视频(按钮在,撤销重做按钮在)。
 *   D1 桌面:`.pc-titlebar` 在,菜单行(文件/编辑/视图/帮助)和三个窗口按钮(最小化/最大化/关闭)都在。
 *   D2 桌面:点「文件」开得出菜单,里面有「导出视频」「返回首页」;点「帮助」开得出,里面有「快捷键」「关于 PromptCut」。
 *   D3 桌面:顶栏「⋯」菜单里没有「快捷键」「关于 PromptCut」(不重复)。
 * 截图写进 `--out`:`online-editor.png`(在线,标题栏两组都不在)、`online-more-menu.png`(在线,「⋯」菜单展开)、
 * `desktop-editor.png`(桌面,两组都在)、`desktop-file-menu.png`(桌面,「文件」菜单展开)。
 */
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def; };
const ONLINE_PORT = Number(arg('online-port', '5960'));
const DESKTOP_PORT = Number(arg('desktop-port', '5963'));
const OUT = path.resolve(ROOT, arg('out', 'out/browser-titlebar'));
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const report = (check, ok, extra = {}) => { results.push({ check, ok }); console.log(JSON.stringify({ check, ok, ...extra })); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const viteBin = path.join(path.dirname(createRequire(import.meta.url).resolve('vite/package.json')), 'bin', 'vite.js');

function startVite(port, mode) {
  const args = [viteBin, ...(mode ? ['--mode', mode] : []), '--port', String(port), '--strictPort', '--host', '127.0.0.1'];
  const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, PROMPTCUT_NO_PORT_FILE: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  child.getLog = () => log;
  return child;
}
async function waitHttp(port, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const ok = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 2000 }, (res) => { res.resume(); resolve(res.statusCode < 500); });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
    if (ok) return true;
    await sleep(300);
  }
  return false;
}
const killTree = (child) => { try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* 已退出 */ } };

const servers = [startVite(ONLINE_PORT, 'online'), startVite(DESKTOP_PORT, null)];
let browser;
try {
  for (const [s, port] of [[servers[0], ONLINE_PORT], [servers[1], DESKTOP_PORT]]) {
    if (!(await waitHttp(port))) { report('dev-server', false, { port, log: s.getLog().slice(-600) }); throw new Error(`dev server ${port} 没起来`); }
  }
  browser = await puppeteer.launch({ headless: true, args: [...PROBE_CHROME_ARGS, '--window-size=1500,900'], defaultViewport: { width: 1500, height: 900 } });

  async function openEditor(port) {
    const page = await browser.newPage();
    const dialogs = [];
    page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
    await page.goto(`http://127.0.0.1:${port}/?editor`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.pc-bar--main', { timeout: 60000 });
    await sleep(1500); // 让皮肤、布局落定
    return { page, dialogs };
  }
  const textOf = (page, sel) => page.$$eval(sel, (els) => els.map((e) => (e.textContent || '').trim()));
  const clickByText = async (page, sel, text) => {
    const handles = await page.$$(sel);
    for (const h of handles) {
      const t = await h.evaluate((e) => (e.textContent || '').trim());
      if (t.startsWith(text)) { await h.click(); return true; }
    }
    return false;
  };

  // ---------------- 在线
  {
    const { page, dialogs } = await openEditor(ONLINE_PORT);
    const probe = await page.evaluate(() => ({
      online: Boolean(document.querySelector('.pc-bar--main')),
      titlebar: document.querySelectorAll('.pc-titlebar').length,
      menus: document.querySelectorAll('.pc-titlebar-menus').length,
      controls: document.querySelectorAll('.pc-titlebar-window-controls').length,
      controlBtns: document.querySelectorAll('.pc-window-control').length,
      menuButtons: [...document.querySelectorAll('button')].filter((b) => b.classList.contains('pc-titlebar-menu-button') || b.closest('nav[aria-label="应用菜单"]')).map((b) => (b.textContent || '').trim()),
      barTop: document.querySelector('.pc-bar--main')?.getBoundingClientRect().top,
    }));
    report('O1 在线:标题栏的菜单行、窗口按钮都不在', probe.online && probe.titlebar === 0 && probe.menus === 0 && probe.controls === 0 && probe.controlBtns === 0 && probe.menuButtons.length === 0, probe);
    report('O2 在线:顶栏贴页面最上沿,没有空占位', probe.barTop === 0, { barTop: probe.barTop });
    await page.screenshot({ path: path.join(OUT, 'online-editor.png') });

    // O4 另五项入口在顶栏上
    const entries = await page.evaluate(() => ({
      undo: Boolean(document.querySelector('[data-pc="undo-btn"] button')),
      redo: Boolean(document.querySelector('[data-pc="redo-btn"] button')),
      labels: [...document.querySelectorAll('.pc-bar--main .pc-btn')].map((b) => (b.textContent || '').trim()),
    }));
    report('O4 在线:撤销、重做、首页、导出视频的入口在顶栏上', entries.undo && entries.redo && entries.labels.includes('首页') && entries.labels.includes('导出视频'), entries);

    // O3 「⋯」菜单
    await page.click('button[title="更多设置"]');
    await page.waitForSelector('.pc-more-menu', { timeout: 5000 });
    const items = await textOf(page, '.pc-more-menu .pc-btn');
    report('O3a 在线:「⋯」菜单里有 皮肤…、快捷键、关于 PromptCut', ['皮肤…', '快捷键', '关于 PromptCut'].every((t) => items.includes(t)), { items });
    await page.screenshot({ path: path.join(OUT, 'online-more-menu.png') });
    await page.click('[data-pc="more-shortcuts"]');
    await sleep(300);
    await page.click('button[title="更多设置"]');
    await page.waitForSelector('[data-pc="more-about"]', { timeout: 5000 });
    await page.click('[data-pc="more-about"]');
    await sleep(300);
    report('O3b 在线:点「快捷键」「关于 PromptCut」各弹出对应说明', dialogs.length === 2 && dialogs[0].startsWith('空格 播放/暂停') && dialogs[1].startsWith('PromptCut'), { dialogs });
    await page.close();
  }

  // ---------------- 桌面
  {
    const { page } = await openEditor(DESKTOP_PORT);
    const probe = await page.evaluate(() => ({
      titlebar: document.querySelectorAll('.pc-titlebar').length,
      menuButtons: [...document.querySelectorAll('.pc-titlebar-menu-button')].map((b) => (b.textContent || '').trim()),
      controls: [...document.querySelectorAll('.pc-window-control')].map((b) => b.getAttribute('aria-label')),
      barTop: document.querySelector('.pc-bar--main')?.getBoundingClientRect().top,
    }));
    report('D1 桌面:标题栏、菜单行(文件/编辑/视图/帮助)和三个窗口按钮都在', probe.titlebar === 1 && JSON.stringify(probe.menuButtons) === JSON.stringify(['文件', '编辑', '视图', '帮助']) && JSON.stringify(probe.controls) === JSON.stringify(['最小化', '最大化', '关闭']), probe);
    await page.screenshot({ path: path.join(OUT, 'desktop-editor.png') });

    await clickByText(page, '.pc-titlebar-menu-button', '文件');
    await page.waitForSelector('.pc-titlebar-menu', { timeout: 5000 });
    const fileItems = await textOf(page, '.pc-titlebar-menu .pc-titlebar-menu-item');
    await page.screenshot({ path: path.join(OUT, 'desktop-file-menu.png') });
    // 菜单开着时鼠标移到别的菜单名上就切过去(onMouseEnter);这里用悬停,点击反而会把刚切过去的又收起
    const helpBtn = (await page.$$('.pc-titlebar-menu-button'))[3];
    await helpBtn.hover();
    await sleep(300);
    const helpItems = await textOf(page, '.pc-titlebar-menu .pc-titlebar-menu-item');
    report('D2 桌面:「文件」菜单里有 导出视频、返回首页;「帮助」菜单里有 快捷键、关于 PromptCut',
      fileItems.some((t) => t.startsWith('导出视频')) && fileItems.some((t) => t.startsWith('返回首页')) && helpItems.some((t) => t.startsWith('快捷键')) && helpItems.some((t) => t.startsWith('关于 PromptCut')), { fileItems, helpItems });

    await page.keyboard.press('Escape');
    await sleep(300);
    const stillOpen = await page.$$eval('.pc-titlebar-menu', (els) => els.length);
    await page.click('button[title="更多设置"]');
    try { await page.waitForSelector('.pc-more-menu', { timeout: 5000 }); } catch (e) { await page.screenshot({ path: path.join(OUT, 'debug-d3.png') }); console.log(JSON.stringify({ debug: 'd3', stillOpen })); throw e; }
    const items = await textOf(page, '.pc-more-menu .pc-btn');
    report('D3 桌面:「⋯」菜单里没有 快捷键、关于 PromptCut(不重复)', !items.includes('快捷键') && !items.includes('关于 PromptCut'), { items });
    await page.close();
  }
} catch (e) {
  report('probe', false, { error: String(e?.stack || e).slice(0, 800) });
} finally {
  try { await browser?.close(); } catch { /* 已关 */ }
  for (const s of servers) killTree(s);
}
const failed = results.filter((r) => !r.ok).length;
console.log(JSON.stringify({ summary: { ok: failed === 0, checks: results.length, failed } }));
process.exit(failed === 0 ? 0 : 1);
