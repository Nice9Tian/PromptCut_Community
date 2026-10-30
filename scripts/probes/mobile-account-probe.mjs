// First import protects user directories and the shared port file before any fixture import.
import '../lib/no-user-dirs.mjs';
/**
 * 手机版走账号版的完整路径(任务书 `docs/plan/mobile-online-task.md` M7 补充:生产上进项目那一半在本机照样走一遍)。
 * 全在本机:真的 VisuHive 账号服务与官网页面、账号版文档服务、独立的素材服务进程(`startAccountDualUserFixture`)、
 * 在线构建当 `/editor/`,两个舞台源(6341、6342);绝不连生产。
 *
 *   node scripts/probes/mobile-account-probe.mjs --dist dist-online --site-root <VisuHive>/site [--out <目录>] [--base-port <N>]
 *   要设 PROMPTCUT_ACCOUNT_PROVIDER_ROOT、PROMPTCUT_PASSWORD_ORDER_MODULE(同全量测试)
 *
 * 用户 2026-10-21 指定测试账号 `test`、密码 `123456`:网站规定密码至少 8 位,先核对 `123456` 被拒(页面的输入框判太短、注册接口回 400),
 * 再用 `12345678` 注册同名账号。之后在安卓仿真(UA + userAgentData.mobile=true、375×812、触屏)里:
 *   官网注册 → 打开 /editor/ 凭共享的登录 cookie 进手机版开始页(不用再输密码)→ 新建云端项目 → 进手机版编辑界面 →
 *   导入一张图并接到主要内容、加一张卡片 → 撤销 / 重做 → 成员面板里有自己 → 回主页、项目在「我的项目」里 → 再点进去内容还在 →
 *   刷新后内容还在;桌面仿真的另一个浏览器上下文用同一账号登录桌面界面,打开同一项目,内容一致。
 * 截图不含密码。结果最后一行是一行 JSON。
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { editorSecurityHeaders, stageSecurityHeaders } from '../../src/online/stagePolicy.mjs';
import { DEVICES, solidPng } from './lib/mobile-env.mjs';

setTimeout(() => { console.error('SCRIPT_TIMEOUT'); process.exit(124); }, 15 * 60_000).unref();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const arg = (key, dflt) => { const i = argv.indexOf(key); return i < 0 ? dflt : argv[i + 1]; };
const DIST = path.resolve(arg('--dist', path.join(ROOT, 'dist-online')));
const SITE = path.resolve(arg('--site-root', path.join(process.env.PROMPTCUT_ACCOUNT_PROVIDER_ROOT ?? '', 'site')));
const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), 'mobile-account-probe')));
await fs.mkdir(OUT, { recursive: true });
// 缺省端口:夹具 6380～6385 + 公共入口 6388、两个舞台源 6341 / 6342;给 --base-port <N> 就改用连着的 9 个(N..N+5 夹具、N+6 公共入口、N+7 / N+8 舞台源),分给别的会话的端口段里跑
const BASE = arg('--base-port', null) === null ? null : Number(arg('--base-port', null));
const FIXTURE_PORTS = BASE === null ? undefined : [0, 1, 2, 3, 4, 5, 6].map((i) => BASE + i);
const ORIGIN = `https://127.0.0.1:${BASE === null ? 6388 : BASE + 6}`;
const STAGE_PORTS = BASE === null ? [6341, 6342] : [BASE + 7, BASE + 8];
const STAGES = STAGE_PORTS.map((p, i) => `http://s${i + 1}.pc.localhost:${p}`);
const ACCOUNT = { name: 'test', asked: '123456', password: '12345678' };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm' };

const fails = [];
const out = { ok: false, out: OUT, steps: {} };
const step = (k, v) => { out.steps[k] = v; };
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 400))); return !!cond; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 30_000, every = 250) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) { fails.push(`等不到:${what}`); return null; }
    await sleep(every);
  }
}

/* ---------------- 静态服务:在线构建当 /editor/,官网页面当其余路径(同 account-user-pages-probe.mjs) ---------------- */
function below(root, relative) { const target = path.resolve(root, relative); const rel = path.relative(root, target); return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? target : null; }
async function sendFile(req, res, root, relative, headers) {
  const file = below(root, relative);
  let stat;
  try { stat = file && await fs.stat(file); } catch { /* 404 */ }
  if (!stat?.isFile()) { res.writeHead(404, headers); res.end(); return; }
  const bytes = await fs.readFile(file);
  res.writeHead(200, { ...headers, 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'content-length': bytes.length, 'cache-control': 'no-store' });
  res.end(req.method === 'HEAD' ? undefined : bytes);
}
function staticHandler(stage = false) {
  return async (req, res) => {
    const headers = stage ? stageSecurityHeaders(ORIGIN) : editorSecurityHeaders(STAGES);
    const url = new URL(req.url, ORIGIN);
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, headers); res.end(); return; }
    if (url.pathname === '/editor/runtime-config.json') { res.writeHead(200, { ...headers, 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ v: 1, stageOrigins: STAGES })); return; }
    if (url.pathname === '/editor/_iso/ok') { res.writeHead(204, headers); res.end(); return; }
    if (url.pathname === '/editor/_iso/redirect') { res.writeHead(302, { ...headers, location: '/editor/_iso/ok' }); res.end(); return; }
    if (url.pathname === '/editor' || url.pathname === '/editor/' || url.pathname === '/editor/index.html') return sendFile(req, res, DIST, 'index.html', headers);
    if (url.pathname.startsWith('/editor/')) return sendFile(req, res, DIST, decodeURIComponent(url.pathname.slice('/editor/'.length)), headers);
    if (url.pathname.startsWith('/catalog/')) return sendFile(req, res, DIST, decodeURIComponent(url.pathname.slice(1)), headers);
    if (!stage) {
      const file = url.pathname === '/' ? 'index.html' : ['/account', '/login', '/register', '/reset'].includes(url.pathname) ? `${url.pathname.slice(1)}.html` : decodeURIComponent(url.pathname.slice(1));
      return sendFile(req, res, SITE, file, { 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' });
    }
    res.writeHead(404, headers); res.end();
  };
}
const stageServers = [];
async function startStage(port) {
  const handler = staticHandler(true);
  const server = http.createServer((req, res) => { void handler(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }); });
  stageServers.push(server);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
}

/* ---------------- 页面小件 ---------------- */
async function newPage(browser, device) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.errors = []; page.bad = [];
  page.on('pageerror', (e) => page.errors.push(String(e?.stack ?? e?.message ?? e).slice(0, 3000)));
  page.on('response', (r) => { if (r.status() >= 500) page.bad.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  const d = DEVICES[device];
  await page.setViewport(d.viewport);
  page.cdp = await page.createCDPSession();
  await page.cdp.send('Emulation.setUserAgentOverride', { userAgent: d.ua, userAgentMetadata: d.meta });
  if (d.viewport.hasTouch) await page.cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  return page;
}
const rect = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; e.scrollIntoView({ block: 'nearest', inline: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }, sel);
const tap = async (page, sel) => { const r = await rect(page, sel); if (!r) throw new Error(`点不到 ${sel}`); await page.touchscreen.tap(r.x + r.w / 2, r.y + r.h / 2); await sleep(350); };
async function typeInto(page, sel, value) {
  const input = await page.waitForSelector(sel, { visible: true });
  await input.evaluate((el) => { el.focus(); el.select?.(); });
  await page.keyboard.press('Backspace');
  await input.type(value);
}
const store = (page, src, ...a) => page.evaluate((s, a2) => new Function('S', 'args', s)(window.__pcStore, a2), src, a);
/** 截图前清空看得见的密码框,截图里不留密码 */
async function shot(page, name) {
  for (const input of await page.$$('input[type="password"]')) await input.evaluate((el) => { el.value = ''; });
  await page.screenshot({ path: path.join(OUT, `${name}.png`) }).catch(() => {});
}
const digest = (page) => store(page, `
  const p = S.getState().project;
  return JSON.stringify({ media: p.media.map((m) => m.id).sort(), tracks: p.tracks.map((t) => ({ id: t.id, clips: t.clips.map((c) => [c.id, +c.start.toFixed(3), +c.end.toFixed(3), c.cardId || null, c.mediaId || null]) })) });`);

let fixture = null, browser = null, P = null;
try {
  const { startAccountDualUserFixture } = await import(pathToFileURL(path.join(ROOT, 'cloud/scripts/probes/account-dual-user-path-probe.mjs')).href);
  fixture = await startAccountDualUserFixture({ ...(FIXTURE_PORTS ? { ports: FIXTURE_PORTS } : {}), publicHandler: staticHandler() });
  check(fixture.origin === ORIGIN, '本机账号版环境起来了', fixture.origin);
  for (const port of STAGE_PORTS) await startStage(port);
  // 本机自签的 TLS(只在 127.0.0.1)
  browser = await puppeteer.launch({ headless: true, acceptInsecureCerts: true, protocolTimeout: 600_000, args: [...PROBE_CHROME_ARGS, '--no-first-run', '--autoplay-policy=no-user-gesture-required'] });

  /* ================ 1. 用户给的密码 123456:网站规定至少 8 位 ================ */
  P = await newPage(browser, 'phone');
  await P.goto(`${ORIGIN}/register`, { waitUntil: 'domcontentloaded' });
  await P.waitForSelector('#register button[type="submit"]:not([disabled])', { timeout: 30_000 });
  await typeInto(P, '#register input[name="name"]', ACCOUNT.name);
  await typeInto(P, '#register input[name="password"]', ACCOUNT.asked);
  await typeInto(P, '#register input[name="again"]', ACCOUNT.asked);
  const clientSide = await P.$eval('#register input[name="password"]', (el) => ({ tooShort: el.validity.tooShort, valid: el.checkValidity(), minLength: el.minLength }));
  const serverSide = await P.evaluate(async (name, password) => {
    const me = await fetch('/api/account/me', { credentials: 'same-origin' }).then((r) => r.json());
    const r = await fetch('/api/account/register', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': me.csrfToken }, body: JSON.stringify({ name, password }) });
    const body = await r.json().catch(() => ({}));
    return { status: r.status, code: body.code ?? body.error ?? null, message: body.message ?? null };
  }, ACCOUNT.name, ACCOUNT.asked);
  step('password123456', { clientSide, serverSide });
  check(clientSide.tooShort && serverSide.status === 400, '123456 被拒:输入框判太短、注册接口回 400(密码至少 8 位)', { clientSide, serverSide });

  /* ================ 2. 用 12345678 在官网注册 test ================ */
  await P.goto(`${ORIGIN}/register`, { waitUntil: 'domcontentloaded' });
  await P.waitForSelector('#register button[type="submit"]:not([disabled])', { timeout: 30_000 });
  await typeInto(P, '#register input[name="name"]', ACCOUNT.name);
  await typeInto(P, '#register input[name="password"]', ACCOUNT.password);
  await typeInto(P, '#register input[name="again"]', ACCOUNT.password);
  await Promise.all([P.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => null), P.click('#register button[type="submit"]')]);
  const afterRegister = new URL(P.url()).pathname;
  step('register', { landed: afterRegister });
  check(afterRegister === '/account', '官网注册 test 成功并进账号页', afterRegister);
  await shot(P, 'a1-site-account');

  /* ================ 3. 手机打开 /editor/:凭共享 cookie 进手机版开始页 ================ */
  await P.goto(`${ORIGIN}/editor/?ui=classic`, { waitUntil: 'domcontentloaded' });
  const chip = await until('手机版开始页认出已登录的 test', () => P.$('[data-pcm="account-chip"]'), 60_000);
  const home = await P.evaluate(() => ({ mobile: !!document.querySelector('[data-pc="mobile-ui"]'), chip: document.querySelector('[data-pcm="account-chip"]')?.textContent?.trim() ?? null, passwordForm: !!document.querySelector('input[type="password"]') }));
  step('mobileHome', home);
  check(home.mobile && /test/.test(home.chip ?? '') && !home.passwordForm, '手机版开始页:已登录 test,不用再输密码', home);
  await shot(P, 'a2-mobile-home');

  /* ================ 4. 新建云端项目 → 进手机版编辑界面 ================ */
  const NAME = `手机账号验收-${Date.now().toString(36)}`;
  await tap(P, '[data-pcm="home-new"]');
  await typeInto(P, '[data-pcm="new-name"]', NAME);
  await tap(P, '[data-pcm="new-submit"]');
  const ed = await until('进手机版编辑界面', () => P.$('[data-pcm="editor"]'), 90_000);
  const projName = await P.evaluate(() => document.querySelector('[data-pcm="project-name"]')?.textContent ?? null);
  step('create', { entered: !!ed, projName });
  check(!!ed && projName === NAME, '新建云端项目并进手机版编辑界面', { projName });
  await shot(P, 'a3-mobile-editor-empty');

  /* ================ 5. 改动:导入一张图接到主要内容、加一张卡片;撤销 / 重做 ================ */
  const img = await solidPng(path.join(OUT, 'acct-img.png'), [220, 120, 40]);
  // 刚进项目时可能还盖着测量遮罩(它拦下按下事件):面板没出来就再点,最多等 30 秒
  const sheetUp = await until('素材库面板打开', async () => { if (await P.$('[data-pcm="sheet-assets"]')) return true; await tap(P, '[data-pcm="sub-image"]'); return !!(await P.$('[data-pcm="sheet-assets"]')); }, 30_000, 1000);
  step('gate', { sheetUp: !!sheetUp, gate: await P.evaluate(() => {
    const b = document.querySelector('[data-pcm="sub-image"]'); const r = b?.getBoundingClientRect();
    const e = r ? document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) : null;
    const chain = []; for (let n = e; n && chain.length < 6; n = n.parentElement) chain.push(`${n.tagName}.${String(n.className).slice(0, 40)}[${n.dataset?.pcm ?? n.dataset?.pc ?? ''}]`);
    return { probeGate: !!document.querySelector('.pc-probe-gate'), btn: !!b, rect: r && [r.x, r.y, r.width, r.height], hit: chain, fixed: [...document.body.children].map((c) => `${c.tagName}.${String(c.className).slice(0, 30)}[${c.dataset?.pc ?? ''}]`) };
  }) });
  await shot(P, 'dbg-before-import');
  await (await P.waitForSelector('[data-pcm="import-input"]')).uploadFile(img);
  await until('图片进素材库', async () => (await P.$$('[data-pcm="asset"]')).length >= 1, 90_000);
  await tap(P, '[data-pcm="asset"]');
  const mainOne = await until('接到主要内容', async () => ((await P.$$('[data-pcm="mblock"]')).length === 1 ? true : null), 15_000);
  await store(P, 'S.actions.seek(1); return true;');
  await tap(P, '[data-pcm="sub-card"]');
  await P.waitForSelector('[data-pcm="card"]', { visible: true });
  const cardId = await P.$eval('[data-pcm="card"]', (b) => b.dataset.card);
  await tap(P, '[data-pcm="card"]');
  const withCard = await until('卡片加进时间轴', () => store(P, 'return S.getState().project.tracks.flatMap((t) => t.clips).some((c) => c.cardId === args[0]);', cardId), 10_000);
  await tap(P, '[data-pcm="undo"]');
  const undone = await until('撤销去掉卡片', async () => !(await store(P, 'return S.getState().project.tracks.flatMap((t) => t.clips).some((c) => c.cardId === args[0]);', cardId)), 10_000);
  await tap(P, '[data-pcm="redo"]');
  const redone = await until('重做加回卡片', () => store(P, 'return S.getState().project.tracks.flatMap((t) => t.clips).some((c) => c.cardId === args[0]);', cardId), 10_000);
  const mediaHash = await store(P, 'return S.getState().project.media.map((m) => ({ kind: m.kind, hash: !!m.hash }));');
  step('edit', { mainOne: !!mainOne, cardId, withCard: !!withCard, undone: !!undone, redone: !!redone, media: mediaHash });
  check(!!mainOne && mediaHash.length === 1 && mediaHash[0].hash, '导入图片(进账号版素材服务、带哈希)并接到主要内容', mediaHash);
  check(!!withCard && !!undone && !!redone, '加卡片、撤销、重做', { withCard, undone, redone });
  await tap(P, '[data-pcm="tl-done"]').catch(() => {});
  await shot(P, 'a4-mobile-edited');

  /* ================ 6. 成员面板里有自己 ================ */
  out.membersHit = await P.evaluate(() => {
    const b = document.querySelector('[data-pcm="members-btn"]'); const r = b?.getBoundingClientRect();
    const e = r ? document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) : null;
    const chain = []; for (let n = e; n && chain.length < 5; n = n.parentElement) chain.push(`${n.tagName}.${String(n.className).slice(0, 30)}[${n.dataset?.pcm ?? n.dataset?.pc ?? ''}]`);
    return { rect: r && [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], chain, vw: innerWidth, vh: innerHeight };
  });
  await tap(P, '[data-pcm="members-btn"]');
  out.membersAfterTouch = await P.evaluate(() => !!document.querySelector('[data-pcm="sheet-members"]'));
  const members = await until('成员面板列出 test', () => P.evaluate(() => { const rows = [...document.querySelectorAll('[data-pcm="member-row"]')].map((r) => r.textContent); return rows.some((t) => /test（自己）/.test(t)) ? rows : null; }), 30_000);
  step('members', members ?? await P.evaluate(() => ({ sheet: !!document.querySelector('[data-pcm="sheet-members"]'), title: document.querySelector('[data-pcm="sheet-members"] h3')?.textContent ?? null, body: document.querySelector('[data-pcm="sheet-members"] .sheet-body')?.textContent?.slice(0, 300) ?? null, page: document.querySelector('[data-pcm="editor"]')?.getAttribute('data-page') })));
  check(!!members, '成员面板(账号项目)列出 test(自己)', members);
  await shot(P, 'a5-mobile-members');
  const close = await P.evaluate(() => { const b = [...document.querySelectorAll('.sheet-head button[aria-label="关闭"]')].pop(); if (!b) return null; const q = b.getBoundingClientRect(); return { x: q.x + q.width / 2, y: q.y + q.height / 2 }; });
  if (close) { await P.touchscreen.tap(close.x, close.y); await sleep(400); }

  /* ================ 7. 回主页:项目在「我的项目」里;点进去内容还在 ================ */
  await sleep(1500);
  const dEdited = await digest(P);
  await tap(P, '[data-pcm="top-home"]');
  const listed = await until('「我的项目」里有新项目', () => P.evaluate((n) => [...document.querySelectorAll('[data-pcm="proj"] .name')].some((e) => e.textContent === n), NAME), 30_000);
  await shot(P, 'a6-mobile-home-list');
  const projectId = await P.evaluate((n) => [...document.querySelectorAll('[data-pcm="proj"]')].find((b) => b.querySelector('.name')?.textContent === n)?.dataset.project ?? null, NAME);
  await tap(P, `[data-pcm="proj"][data-project="${projectId}"]`);
  await until('再次进入项目', () => P.$('[data-pcm="editor"]'), 90_000);
  const dReopen = await until('内容同步回来', async () => { const d = await digest(P); return d === dEdited ? d : null; }, 30_000, 500);
  step('reopen', { listed: !!listed, projectId, same: dReopen === dEdited });
  check(!!listed && dReopen === dEdited, '回主页项目在列表里,再点进去内容还在', { listed, projectId });

  /* ================ 8. 刷新后仍在 ================ */
  await P.reload({ waitUntil: 'domcontentloaded' });
  const afterReload = await until('刷新后回到项目或开始页', async () => (await P.$('[data-pcm="editor"]')) ? 'editor' : (await P.$('[data-pcm="proj"]')) ? 'home' : null, 60_000);
  if (afterReload === 'home') { await tap(P, `[data-pcm="proj"][data-project="${projectId}"]`); await until('刷新后再进项目', () => P.$('[data-pcm="editor"]'), 90_000); }
  const dReload = await until('刷新后内容', async () => { const d = await digest(P); return d === dEdited ? d : null; }, 30_000, 500);
  step('reload', { landed: afterReload, same: dReload === dEdited });
  check(dReload === dEdited, '刷新后改动都还在', { afterReload });
  await shot(P, 'a7-mobile-after-reload');

  /* ================ 9. 桌面:同一账号登录桌面界面,打开同一项目,内容一致 ================ */
  const D = await newPage(browser, 'desktop');
  await D.goto(`${ORIGIN}/editor/?ui=classic`, { waitUntil: 'domcontentloaded' });
  await typeInto(D, '[data-pc="account-projects"] input[name="username"]', ACCOUNT.name);
  await typeInto(D, '[data-pc="account-projects"] input[name="password"]', ACCOUNT.password);
  await D.waitForFunction(() => !document.querySelector('[data-pc="account-projects"] form button.sp-primary-btn')?.disabled);
  await D.click('[data-pc="account-projects"] form button.sp-primary-btn');
  await until('桌面登录', () => D.$('[data-pc="account-name"]'), 30_000);
  const opened = await D.evaluate((n) => { const b = [...document.querySelectorAll('[data-pc="cloud-project-lists"] button')].find((x) => x.textContent === n); b?.click(); return !!b; }, NAME);
  await until('桌面进编辑台', () => D.$('[data-pc="editor"]'), 90_000);
  await until('桌面的 store', () => D.evaluate(() => !!window.__pcStore), 30_000);
  const dDesk = await until('桌面内容同步', async () => { const d = await digest(D); return d === dEdited ? d : null; }, 30_000, 500);
  const deskUi = await D.evaluate(() => ({ desktop: !!document.querySelector('[data-pc="editor"]'), mobile: !!document.querySelector('[data-pc="mobile-ui"]') }));
  step('desktop', { opened, same: dDesk === dEdited, ui: deskUi });
  check(opened && dDesk === dEdited && deskUi.desktop && !deskUi.mobile, '桌面界面用同一账号打开同一项目,内容和手机改的一致', { opened, deskUi });
  await shot(D, 'a8-desktop-same-project');

  out.pageErrors = { phone: P.errors, desktop: D.errors };
  out.serverErrors = { phone: P.bad, desktop: D.bad };
  check(P.errors.length === 0 && D.errors.length === 0, '两边页面都没有未捕获的错误', out.pageErrors);
} catch (e) {
  fails.push(`探针异常:${e?.stack ?? e}`);
  if (P) { out.phoneErrorsAtFailure = P.errors.map((e) => e.slice(0, 300)); out.snapLog = await P.evaluate(() => window.__snapLog ?? null).catch(() => null); }
} finally {
  out.ok = fails.length === 0;
  out.fails = fails;
  await browser?.close().catch(() => {});
  for (const s of stageServers) { s.closeAllConnections?.(); await new Promise((r) => s.close(() => r())); }
  await fixture?.close?.().catch(() => {});
  console.log(JSON.stringify(out));
  process.exit(out.ok ? 0 : 1);
}
