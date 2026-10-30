/**
 * 托管方的渲染节点——界面的浏览器端验证（契约 `docs/plan/hosted-render-contract.md` 第 1.7、3 节，HR24 的浏览器一半）。
 * 全程在本机：隔离的托管端（`server/hosted/main.mjs`，子进程，临时数据目录）+ 本 worktree 的 dev server + 一个假扮渲染服务的客户端。
 *
 * 用法（端口取本分支的段 5760～5769、8782～8783）：
 *   node scripts/probes/hosted-render-ui-probe.mjs --out <截图目录> [--desktop-port 5760] [--doc-port 8782] [--asset-port 8783]
 *
 * 起的东西（都由本探针起、跑完关掉）：
 * - 托管组合：`PROMPTCUT_DATA_DIR` 是临时目录，`PROMPTCUT_TRUST_LOOPBACK=0` 加一份临时集群令牌（与新节点同样的配置）；
 *   先用 `server/hosted-render/keygen.mjs` 生成一份服务登记表，托管端因此对 `render` 报 `available: true`；
 * - 桌面编辑器：`vite --port <desktop-port> --strictPort`，数据目录临时，`PROMPTCUT_PUSH=0`；
 * - 假的渲染服务：照契约第 1.2、1.3 节握手（Ed25519 签名）、订阅目录、要票据、开数据连接，只为了在成员列表里出现一行服务。
 *
 * 断言（每项一行 JSON `{ check, ok, … }`，最后一行 `{ summary }`；有失败退出码 1）：
 *   U1 没开协作时没有这一组；创建者放云端开启后，项目设置里出现「托管方的渲染节点」，缺省勾上、创建者可点
 *   U2 成员加入后在自己的项目设置里看到同一项：勾着、禁用（只读）、带「只有创建者能改」
 *   U3 假的渲染服务连上后，成员列表里出现「托管方的渲染节点」一行：在成员之后、没有踢人按钮、成员数不含它
 *   U4 创建者取消勾选（验证创建者身份 → 确认）：创建者的勾选取消；成员那一端 5 s 内跟着变、看到一条气泡；
 *      服务连接以 4003 `service-disabled` 关闭、成员列表里的服务行消失
 *   U5 再勾上：两端的勾选都回来；服务能重新要票据、连回来
 *   U6 手里有认领时服务行带「渲染中」（用验收钩子注入一条带 `tags.rendering` 的成员列表）
 * 截图写进 --out：`ui-1-creator-settings.png`、`ui-2-member-members-list.png`，另有 `ui-3-member-settings-readonly.png`、`ui-4-member-settings-off.png`。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createPrivateKey, randomBytes, sign } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { lookupProject } from '../../server/auth/client.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), 'hosted-render-ui-shots')));
const DESKTOP_PORT = Number(arg('--desktop-port', 5760));
const DOC_PORT = Number(arg('--doc-port', 8782));
const ASSET_PORT = Number(arg('--asset-port', 8783));
fs.mkdirSync(OUT, { recursive: true });

const DESKTOP = `http://127.0.0.1:${DESKTOP_PORT}`;
const DOC = `http://127.0.0.1:${DOC_PORT}`;

const results = [];
const check = (name, ok, extra = {}) => {
  const r = { check: name, ok: !!ok, ...extra };
  results.push(r);
  console.log(JSON.stringify(r));
  return !!ok;
};
const say = (step, fields = {}) => console.log(JSON.stringify({ step, ...fields }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 15_000, what = '条件') {
  const t0 = Date.now();
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    if (Date.now() - t0 > ms) throw new Error(`等 ${what} 超时${last instanceof Error ? `：${last.message}` : ''}`);
    await sleep(150);
  }
}

/* ------------------------------------------------------------------ 起托管端 */

const hostedData = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-ui-hosted-'));
const renderSecrets = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-ui-render-secrets-'));
const editorData = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-ui-editor-'));
fs.mkdirSync(path.join(hostedData, 'secrets'), { recursive: true });
fs.writeFileSync(path.join(hostedData, 'secrets', 'cluster-token'), `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600 });

const kg = spawnSync(process.execPath, [path.join(ROOT, 'cloud/server/hosted-render/keygen.mjs'), '--hosted-data', hostedData, '--secrets', renderSecrets, '--instance-name', 'ui-probe-render'], { encoding: 'utf8', windowsHide: true });
const kgOut = JSON.parse(kg.stdout.trim().split('\n').pop() ?? '{}');
if (!kgOut.ok) throw new Error(`keygen 失败：${kg.stderr}`);
say('keygen', { kid: kgOut.kid, service: kgOut.service, role: kgOut.role });
const serviceKey = JSON.parse(fs.readFileSync(path.join(renderSecrets, 'service-key.json'), 'utf8'));

const hostedLog = [];
const hostedProc = spawn(process.execPath, [path.join(ROOT, 'cloud/server/hosted/main.mjs')], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  env: { ...process.env, PROMPTCUT_DATA_DIR: hostedData, PROMPTCUT_DOCSERVICE_HOST: '127.0.0.1', PROMPTCUT_DOCSERVICE_PORT: String(DOC_PORT), PROMPTCUT_ASSET_PORT: String(ASSET_PORT), PROMPTCUT_TRUST_LOOPBACK: '0' },
});
for (const s of [hostedProc.stdout, hostedProc.stderr]) s.on('data', (c) => { hostedLog.push(c.toString()); if (hostedLog.length > 200) hostedLog.shift(); });
await waitFor(async () => {
  if (hostedProc.exitCode !== null) throw new Error(`托管端退出了：${hostedLog.join('').slice(-600)}`);
  return fetch(`${DOC}/healthz`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
}, 30_000, '托管端起来');
say('hosted.up', { doc: DOC, asset: ASSET_PORT, dataDir: hostedData });

/* ------------------------------------------------------------------ 起 dev server 与浏览器 */

function viteBin() {
  const main = createRequire(import.meta.url).resolve('vite');
  const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
  return path.join(main.slice(0, at + 6), 'bin', 'vite.js');
}
const editorLog = [];
const editorEnv = { ...process.env, PROMPTCUT_PUSH: '0', PROMPTCUT_DATA_DIR: editorData, PROMPTCUT_EXPORT_DIR: path.join(editorData, 'out'), PROMPTCUT_DEVICE_ID: 'hr-ui-probe-desktop-01', PROMPTCUT_DEVICE_NAME: 'ProbeDesk' };
delete editorEnv.PROMPTCUT_LAN_HOST;
const editorProc = spawn(process.execPath, [viteBin(), '--port', String(DESKTOP_PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: editorEnv });
for (const s of [editorProc.stdout, editorProc.stderr]) s.on('data', (c) => { editorLog.push(c.toString()); if (editorLog.length > 300) editorLog.shift(); });
await waitFor(async () => {
  if (editorProc.exitCode !== null) throw new Error(`编辑器退出了：${editorLog.join('').slice(-600)}`);
  return fetch(`${DESKTOP}/`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
}, 180_000, '桌面编辑器起来');
say('desktop.up', { url: DESKTOP, pid: editorProc.pid });

const browser = await puppeteer.launch({
  headless: true,
  defaultViewport: { width: 1440, height: 900 },
  args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1'],
});

let service = null;
async function shutdown() {
  try { service?.close(); } catch { /* 已关 */ }
  try { await browser.close(); } catch { /* 已关 */ }
  for (const proc of [editorProc, hostedProc]) {
    if (proc.exitCode === null && proc.pid) {
      const exited = new Promise((r) => proc.once('exit', r));
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      else proc.kill('SIGKILL');
      await Promise.race([exited, sleep(10_000)]);
    }
  }
  for (const d of [hostedData, renderSecrets, editorData]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 句柄还没放 */ } }
}

/* ------------------------------------------------------------------ 页面工具 */

async function newPage() {
  const ctx = await browser.createBrowserContext(); // 各自一份本地存储 = 各自一台设备
  const page = await ctx.newPage();
  page.consoleErrors = [];
  page.on('pageerror', (e) => page.consoleErrors.push(String(e?.message ?? e)));
  page.close$ = () => ctx.close();
  return page;
}
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`) }).then(() => say('shot', { file: path.join(OUT, `${name}.png`) }));
async function typeInto(page, sel, text) {
  await page.waitForSelector(sel, { visible: true, timeout: 15_000 });
  await page.click(sel);
  await page.$eval(sel, (el) => el.select());
  await page.keyboard.press('Backspace');
  if (text) await page.type(sel, text, { delay: 5 });
}
const textOf = (page, sel) => page.$eval(sel, (el) => el.textContent ?? '').catch(() => '');
const waitMembers = (page, ms = 60_000) => page.waitForSelector('[data-pc="members-button"]', { visible: true, timeout: ms });

async function dismissAiSetup(page) {
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    const closed = await page.evaluate(() => {
      const dlg = [...document.querySelectorAll('[role="dialog"], .pc-dialog')].find((d) => /选择 AI 助手的驱动方式/.test(d.textContent ?? ''));
      if (!dlg) return false;
      const btn = [...dlg.querySelectorAll('button')].find((b) => b.textContent?.trim() === '关闭');
      btn?.click();
      return !!btn;
    });
    if (closed) { await sleep(300); return; }
    await sleep(250);
  }
}

/** 开发服务器第一次载编辑器很慢：监听挂上之前发的事件会丢，所以隔几秒再发一次，直到设置里的「多用户协作」出来 */
const openSettings = async (page, ms = 90_000) => {
  const t0 = Date.now();
  for (;;) {
    await page.evaluate(() => window.dispatchEvent(new Event('pc-open-project-settings')));
    const ok = await page.waitForSelector('[data-pc="collab-section"]', { visible: true, timeout: 3000 }).then(() => true, () => false);
    if (ok) return;
    if (Date.now() - t0 > ms) throw new Error(`项目设置没打开：页面错误 ${JSON.stringify(page.consoleErrors.slice(0, 3))}`);
  }
};
const toggleState = (page) => page.$eval('[data-pc="collab-hosted-render-toggle"]', (i) => ({ checked: i.checked, disabled: i.disabled })).catch(() => null);
const hintOf = (page) => textOf(page, '[data-pc="collab-hosted-render-hint"]');

/** 假的渲染服务：契约第 1.2、1.3 节的握手、订阅目录、要票据、开数据连接 */
function startFakeService() {
  const toB64u = (buf) => Buffer.from(buf).toString('base64url');
  const state = { control: null, data: new Map(), closes: [] };
  const ask = (ws, msg, until) => new Promise((resolve, reject) => {
    const reqId = `r${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => reject(new Error(`等 ${msg.type} 回包超时`)), 8000);
    const on = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.reqId !== reqId && !(until && m.type === until)) return;
      clearTimeout(timer);
      ws.removeEventListener('message', on);
      resolve(m);
    };
    ws.addEventListener('message', on);
    ws.send(JSON.stringify({ ...msg, reqId }));
  });
  const open = (protocols) => new Promise((resolve, reject) => {
    const ws = new WebSocket(DOC.replace(/^http/, 'ws'), protocols);
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', () => reject(new Error('服务连接没建成')), { once: true });
  });
  async function connectControl() {
    const ch = await fetch(`${DOC}/shared/service-challenge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ service: 'render', deviceId: serviceKey.instanceId }) }).then((r) => r.json());
    const priv = createPrivateKey({ key: Buffer.from(serviceKey.priv, 'base64url'), format: 'der', type: 'pkcs8' });
    const m = sign(null, Buffer.from(`promptcut.service.v1\nrender\n${serviceKey.instanceId}\n${ch.nonce}`, 'utf8'), priv).toString('base64url');
    const item = { v: 1, s: 'render', kid: serviceKey.kid, d: serviceKey.instanceId, dn: serviceKey.instanceName, nonce: ch.nonce, m };
    state.control = await open(['promptcut.v1', `promptcut.service.${toB64u(JSON.stringify(item))}`]);
    const watch = await ask(state.control, { type: 'hosted.watch' }, 'hosted.projects');
    return watch;
  }
  async function connectProject(projectId) {
    const t = await ask(state.control, { type: 'hosted.ticket', projectId }, 'hosted.ticket.ok');
    if (t.type !== 'hosted.ticket.ok') return { ok: false, reply: t };
    const ws = await open(['promptcut.v1', `promptcut.ticket.${t.ticket}`]);
    ws.addEventListener('close', (ev) => state.closes.push({ projectId, code: ev.code, reason: ev.reason }));
    state.data.set(projectId, ws);
    return { ok: true, ws };
  }
  return { state, connectControl, connectProject, ask, close() { for (const ws of [state.control, ...state.data.values()]) { try { ws?.close(); } catch { /* 已关 */ } } } };
}

/* ------------------------------------------------------------------ 场景 */

const stamp = Date.now().toString(36);
const NAME = `渲染节点界面-${stamp}`;

async function main() {
  // —— 创建者页面：桌面编辑器，项目设置里开启多用户协作、放云端
  const creator = await newPage();
  await creator.goto(`${DESKTOP}/?editor`, { waitUntil: 'domcontentloaded' });
  await creator.waitForFunction(() => !!document.querySelector('.pc-proj-menu, [data-pc="probe-gate"], header, .pc-topbar') || document.readyState === 'complete', { timeout: 60_000 });
  await dismissAiSetup(creator);
  await openSettings(creator);
  await typeInto(creator, '#pc-proj-name', NAME);
  check('U1.no-row-before-collab', !(await creator.$('[data-pc="collab-hosted-services"]')), { note: '没开协作时没有这一组' });
  await creator.click('[data-pc="collab-toggle"]');
  await creator.waitForSelector('[data-pc="collab-where-hosted"]', { visible: true });
  check('U1.no-row-in-create-form', !(await creator.$('[data-pc="collab-hosted-services"]')), { note: '创建表单里（还没有项目）不出现' });
  const creatorName = await creator.$eval('#pc-collab-creator', (i) => i.value);
  const creatorPw = await creator.$eval('#pc-collab-cpw', (i) => i.value);
  const projectPw = await creator.$eval('#pc-collab-ppw', (i) => i.value);
  await creator.click('[data-pc="collab-where-hosted"]');
  await typeInto(creator, '[data-pc="collab-hosted-url"]', DOC);
  await creator.click('.pc-dialog-foot .pc-btn--primary');
  const status = await waitFor(async () => {
    const t = await textOf(creator, '[data-pc="collab-status"]');
    return t && !t.includes('正在设置') ? t : null;
  }, 40_000, '开启结果');
  check('U1.enabled', status.includes('多用户协作已开启。'), { status });
  await creator.waitForSelector('[data-pc="collab-hosted-render"]', { visible: true, timeout: 15_000 }).catch(() => {});
  const c0 = await toggleState(creator);
  check('U1.creator-row-shown-checked-editable', !!c0 && c0.checked === true && c0.disabled === false, { state: c0, label: await textOf(creator, '[data-pc="collab-hosted-render"] label') });
  await shot(creator, 'ui-1-creator-settings');
  const found = await lookupProject({ base: DOC, name: NAME });
  const projectId = found.projectId;

  // —— 成员页面：另一个浏览器上下文，开始页手填加入
  const member = await newPage();
  await member.goto(`${DESKTOP}/`, { waitUntil: 'domcontentloaded' });
  await member.waitForSelector('[data-pc="join-form"]', { visible: true, timeout: 60_000 });
  await member.click('::-p-text(服务器地址)');
  await typeInto(member, '#pc-join-server', DOC);
  await typeInto(member, '[data-pc="join-name"]', NAME);
  await typeInto(member, '[data-pc="join-username"]', '成员小王');
  await typeInto(member, '[data-pc="join-password"]', projectPw);
  await member.click('[data-pc="join-submit"]');
  await waitMembers(member, 60_000);
  await sleep(1500);
  await openSettings(member);
  await member.waitForSelector('[data-pc="collab-hosted-render"]', { visible: true, timeout: 15_000 }).catch(() => {});
  const m0 = await toggleState(member);
  const mHint = await hintOf(member);
  check('U2.member-row-readonly', !!m0 && m0.checked === true && m0.disabled === true && mHint.includes('只有创建者能改'), { state: m0, hint: mHint });
  await shot(member, 'ui-3-member-settings-readonly');
  await member.keyboard.press('Escape');
  await sleep(300);

  // —— 假的渲染服务连上：成员列表里出现一行
  service = startFakeService();
  const watch = await service.connectControl();
  const listed = (watch.projects ?? []).find((p) => p.projectId === projectId);
  check('U3.directory-lists-project', !!listed && listed.enabled === true, { listed: listed ? { enabled: listed.enabled, active: listed.active, members: listed.members, hosted: listed.hosted } : null });
  const conn = await service.connectProject(projectId);
  check('U3.service-connected', conn.ok, { reply: conn.ok ? undefined : conn.reply });
  await member.click('[data-pc="members-button"]');
  await member.waitForSelector('[data-pc="members-service-render"]', { visible: true, timeout: 10_000 }).catch(() => {});
  const list1 = await member.evaluate(() => {
    const pop = document.querySelector('[data-pc="members-pop"]');
    const rows = [...(pop?.querySelectorAll('.pc-members-row') ?? [])].map((r) => ({ text: r.textContent?.trim() ?? '', service: r.getAttribute('data-pc')?.startsWith('members-service-') ?? false, kick: !!r.querySelector('.pc-members-kick') }));
    return { rows, button: document.querySelector('[data-pc="members-button"]')?.textContent ?? '' };
  });
  const svcIdx = list1.rows.findIndex((r) => r.service);
  const ok3 = svcIdx >= 0 && list1.rows[svcIdx].text.includes('托管方的渲染节点') && !list1.rows[svcIdx].text.includes('service:render')
    && list1.rows.slice(svcIdx + 1).every((r) => r.service) && list1.rows.slice(0, svcIdx).every((r) => !r.service)
    && !list1.rows[svcIdx].kick && /成员[:：] ?2 人/.test(list1.button);
  check('U3.service-row-after-members-not-counted-no-kick', ok3, list1);
  await shot(member, 'ui-2-member-members-list');
  await member.keyboard.press('Escape');
  await member.mouse.click(700, 887);

  // —— 创建者取消勾选：验证创建者身份 → 确认
  async function creatorToggle(page, want) {
    await page.click('[data-pc="collab-hosted-render-toggle"]');
    await page.waitForSelector('[data-pc="creator-verify"]', { visible: true, timeout: 10_000 });
    await typeInto(page, '#pc-cv-pw', creatorPw);
    await page.evaluate(() => [...document.querySelectorAll('[data-pc="creator-verify"] button')].find((b) => b.textContent?.trim() === '验证')?.click());
    await page.waitForSelector('[data-pc="hosted-service-dialog"]', { visible: true, timeout: 15_000 });
    const body = await textOf(page, '[data-pc="hosted-service-dialog"] .pc-dialog-body');
    await page.click('[data-pc="hosted-service-confirm"]');
    await page.waitForFunction(() => !document.querySelector('[data-pc="hosted-service-dialog"]'), { timeout: 15_000 });
    return { body, want };
  }
  // 成员的项目设置开着再让创建者改:验的是「已经开着的界面跟着变」,不是重开之后读到新值
  await openSettings(member);
  const closesBefore = service.state.closes.length;
  const off = await creatorToggle(creator, false);
  const cOff = await waitFor(async () => { const s = await toggleState(creator); return s && s.checked === false ? s : null; }, 8000, '创建者的勾选取消');
  check('U4.creator-unchecked', !!cOff, { dialog: off.body });
  const mOff = await waitFor(async () => { const s = await toggleState(member); return s && s.checked === false ? s : null; }, 5000, '成员那一端跟着取消').catch(() => null);
  check('U4.member-follows-within-5s', !!mOff && mOff.disabled === true, { state: mOff });
  const toastText = await member.evaluate(() => document.body.innerText.match(/创建者关闭了托管方的渲染节点[^\n]*/)?.[0] ?? null);
  check('U4.member-toast', !!toastText, { toast: toastText });
  const closed = await waitFor(() => service.state.closes.slice(closesBefore).find((c) => c.projectId === projectId), 8000, '服务连接被关').catch(() => null);
  check('U4.service-conn-closed-4003', !!closed && closed.code === 4003 && closed.reason === 'service-disabled', { closed });
  await shot(member, 'ui-4-member-settings-off');
  const denied = await service.ask(service.state.control, { type: 'hosted.ticket', projectId }, 'hosted.ticket.ok').catch((e) => ({ type: 'timeout', reason: String(e.message) }));
  check('U4.ticket-refused-while-off', denied.type === 'error' && denied.reason === 'service-disabled', denied);
  await member.keyboard.press('Escape');
  await member.waitForFunction(() => !document.querySelector('[data-pc="collab-section"]'), { timeout: 5000 }).catch(() => {});
  await member.click('[data-pc="members-button"]');
  await sleep(500);
  const svcGone = await member.evaluate(() => !document.querySelector('[data-pc="members-service-render"]'));
  check('U4.service-row-gone', svcGone);
  await member.keyboard.press('Escape');
  await member.mouse.click(700, 887);

  // —— 再勾上
  await creator.evaluate(() => window.dispatchEvent(new Event('pc-open-project-settings')));
  await creator.waitForSelector('[data-pc="collab-hosted-render-toggle"]', { visible: true, timeout: 10_000 });
  await member.mouse.click(700, 887);
  await openSettings(member);
  await creatorToggle(creator, true);
  await waitFor(async () => (await toggleState(creator))?.checked === true, 8000, '创建者勾回');
  const mOn = await waitFor(async () => { const s = await toggleState(member); return s && s.checked === true ? s : null; }, 5000, '成员勾回').catch(() => null);
  check('U5.both-checked-again', !!mOn && (await toggleState(creator)).checked === true, { member: mOn });
  const again = await service.connectProject(projectId).catch((e) => ({ ok: false, reply: String(e.message) }));
  check('U5.service-can-reconnect', again.ok, { reply: again.ok ? undefined : again.reply });
  await member.keyboard.press('Escape');
  await member.waitForFunction(() => !document.querySelector('[data-pc="collab-section"]'), { timeout: 5000 }).catch(() => {});
  await member.click('[data-pc="members-button"]');
  const back = await member.waitForSelector('[data-pc="members-service-render"]', { visible: true, timeout: 8000 }).then(() => true, () => false);
  check('U5.service-row-back', back);

  // —— 手里有认领时的「渲染中」：注入一条带 tags.rendering 的成员列表（验收钩子只在开发模式）
  const rendering = await member.evaluate(() => {
    const hook = window.__pcSyncTest;
    if (!hook?.inject) return null;
    const v = hook.view();
    const rows = v.members.map((r) => (r.service ? { ...r, tags: { ...r.tags, rendering: true } } : r));
    hook.inject({ type: 'shared.members.list', devices: rows, hosted: v.hosted });
    return new Promise((resolve) => setTimeout(() => resolve(document.querySelector('[data-pc="members-service-render"]')?.textContent ?? null), 300));
  });
  check('U6.rendering-tag', !!rendering && rendering.includes('渲染中') && rendering.includes('托管方的渲染节点'), { text: rendering });

  const errs = [...new Set([...creator.consoleErrors, ...member.consoleErrors])];
  check('page-errors', errs.length === 0, { sample: errs.slice(0, 5) });
  await creator.close$();
  await member.close$();
}

let failed = false;
try {
  await main();
} catch (e) {
  failed = true;
  console.log(JSON.stringify({ check: 'probe.fatal', ok: false, error: String(e?.stack ?? e).slice(0, 1200), hostedLog: hostedLog.join('').slice(-600) }));
}
await shutdown();
const bad = results.filter((r) => !r.ok);
console.log(JSON.stringify({ summary: { ok: !failed && bad.length === 0, total: results.length, failed: bad.map((r) => r.check) } }));
process.exit(!failed && bad.length === 0 ? 0 : 1);
