/**
 * 项目设置里「托管方的渲染节点」下面的子选项「生成轨道流」——界面的浏览器端验证
 * （契约 `docs/plan/hosted-render-contract.md` 第 3.1 节；单测见 `src/editor/sync/hostedServices.test.mjs` 的 HS10～HS12、
 * `cloud/server/test/hosted-stream-option.test.mjs`）。
 * 全程在本机：隔离的托管端（`server/hosted/main.mjs`，子进程，临时数据目录）+ 本 worktree 的 dev server + 两个浏览器上下文
 * （创建者、成员）。不需要假的渲染服务：渲染节点「可用」只看托管端的服务登记表，`keygen.mjs` 生成一份就有。
 *
 * 用法（端口取本分支的段 5760～5769）：
 *   node scripts/probes/hosted-stream-entry-probe.mjs --out <截图目录> [--desktop-port 5760] [--doc-port 5763] [--asset-port 5764]
 *   （dev server 另占 +1、+2 当舞台端口，所以桌面端口留 5760，文档与素材服务用 5763、5764）
 *
 * 缺省是关（2026-10-12 用户定：在线浏览器暂停时不靠渲染节点也能看任意一帧，云端缺省不产轨道流）。
 *
 * 断言（每项一行 JSON `{ check, ok, … }`，最后一行 `{ summary }`；有失败退出码 1；成功时 summary 里 `fails: []`）：
 *   S1 创建者放云端开启协作后，渲染节点那一行下面缩进多一行「生成轨道流」：缺省不勾、创建者可点、挂在渲染节点那一块里，
 *      关着的说明讲清代价（「没有打开：…会多用云端的渲染时间。」）
 *   S2 成员加入后在自己的项目设置里看到同一项：没勾、禁用（只读）、带「只有创建者能改」
 *   S3 创建者勾上（验证创建者身份 → 确认弹窗，弹窗里是约定的一句话）：创建者的勾选勾上；成员那一端 5 s 内跟着变，
 *      且没有提示（打开时不提示）
 *   S4 创建者再取消：成员那一端跟着变、收到一条「创建者关闭了轨道流…」的提示
 *   S5 创建者再勾上；渲染节点那一行关掉：轨道流这一行置灰（禁用、带置灰状态），成员那一端同样；它自己的勾选状态不变（还是勾着），
 *      说明后面带「（渲染节点关着，暂不生效）」
 *   S6 渲染节点再打开：轨道流这一行恢复可点，且仍是勾着（渲染节点的开关没有冲掉它）
 *   S7 页面没有未捕获的错误
 * 截图（只截项目设置里「多用户协作」那一块，2 倍清晰度）写进 --out：`off.png`（缺省状态，没勾）、`on.png`（创建者勾上并确认以后）、
 * `disabled.png`（渲染节点关着、轨道流这一行置灰）。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { lookupProject } from '../../server/auth/client.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), 'hosted-stream-entry-shots')));
const DESKTOP_PORT = Number(arg('--desktop-port', 5760));
const DOC_PORT = Number(arg('--doc-port', 5763));
const ASSET_PORT = Number(arg('--asset-port', 5764));
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

const hostedData = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-ui-hosted-'));
const renderSecrets = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-ui-render-secrets-'));
const editorData = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-ui-editor-'));
fs.mkdirSync(path.join(hostedData, 'secrets'), { recursive: true });
fs.writeFileSync(path.join(hostedData, 'secrets', 'cluster-token'), `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600 });

const kg = spawnSync(process.execPath, [path.join(ROOT, 'cloud/server/hosted-render/keygen.mjs'), '--hosted-data', hostedData, '--secrets', renderSecrets, '--instance-name', 'stream-entry-probe'], { encoding: 'utf8', windowsHide: true });
const kgOut = JSON.parse(kg.stdout.trim().split('\n').pop() ?? '{}');
if (!kgOut.ok) throw new Error(`keygen 失败：${kg.stderr}`);
say('keygen', { kid: kgOut.kid, service: kgOut.service, role: kgOut.role });

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
const editorEnv = { ...process.env, PROMPTCUT_PUSH: '0', PROMPTCUT_DATA_DIR: editorData, PROMPTCUT_EXPORT_DIR: path.join(editorData, 'out'), PROMPTCUT_DEVICE_ID: 'hs-ui-probe-desktop-01', PROMPTCUT_DEVICE_NAME: 'ProbeDesk' };
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
  defaultViewport: { width: 1440, height: 1000, deviceScaleFactor: 2 },
  args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars'],
});

async function shutdown() {
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
/** 只截项目设置里「多用户协作」那一块 */
async function shotCollab(page, name) {
  const el = await page.waitForSelector('[data-pc="collab-section"]', { visible: true, timeout: 10_000 });
  await sleep(300); // 等过渡动画
  const file = path.join(OUT, `${name}.png`);
  await el.screenshot({ path: file });
  say('shot', { file });
}
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
const SEL = {
  render: '[data-pc="collab-hosted-render-toggle"]',
  streams: '[data-pc="collab-hosted-render-streams-toggle"]',
};
const boxState = (page, sel) => page.$eval(sel, (i) => ({ checked: i.checked, disabled: i.disabled })).catch(() => null);
const streamsBlock = (page) => page.$eval('[data-pc="collab-hosted-render-streams"]', (el) => ({
  state: el.getAttribute('data-state'),
  nestedInRender: !!el.closest('[data-pc="collab-hosted-render"]'),
  indent: parseFloat(getComputedStyle(el).marginLeft),
  opacity: parseFloat(getComputedStyle(el).opacity),
  text: el.textContent ?? '',
})).catch(() => null);
const toastsOf = (page) => page.$$eval('[data-pc="sync-toasts"] .pc-toast', (els) => els.map((e) => e.textContent ?? '')).catch(() => []);

/** 创建者点勾选 → 验证创建者身份 → 确认弹窗 → 确认；dialogPc 是确认弹窗的 data-pc，返回弹窗里的话 */
async function creatorToggle(page, toggleSel, dialogPc, confirmPc, creatorPw) {
  await page.click(toggleSel);
  await page.waitForSelector('[data-pc="creator-verify"]', { visible: true, timeout: 10_000 });
  await typeInto(page, '#pc-cv-pw', creatorPw);
  await page.evaluate(() => [...document.querySelectorAll('[data-pc="creator-verify"] button')].find((b) => b.textContent?.trim() === '验证')?.click());
  await page.waitForSelector(`[data-pc="${dialogPc}"]`, { visible: true, timeout: 15_000 });
  const body = await textOf(page, `[data-pc="${dialogPc}"] .pc-dialog-body`);
  await page.click(`[data-pc="${confirmPc}"]`);
  await page.waitForFunction((pc) => !document.querySelector(`[data-pc="${pc}"]`), { timeout: 15_000 }, dialogPc);
  return body.trim();
}
const toggleStreams = (page, pw) => creatorToggle(page, SEL.streams, 'hosted-option-dialog', 'hosted-option-confirm', pw);
const toggleRender = (page, pw) => creatorToggle(page, SEL.render, 'hosted-service-dialog', 'hosted-service-confirm', pw);

/* ------------------------------------------------------------------ 场景 */

const stamp = Date.now().toString(36);
const NAME = `轨道流入口-${stamp}`;

async function main() {
  // —— 创建者页面：桌面编辑器，项目设置里开启多用户协作、放云端
  const creator = await newPage();
  await creator.goto(`${DESKTOP}/?editor`, { waitUntil: 'domcontentloaded' });
  await creator.waitForFunction(() => !!document.querySelector('.pc-proj-menu, [data-pc="probe-gate"], header, .pc-topbar') || document.readyState === 'complete', { timeout: 60_000 });
  await dismissAiSetup(creator);
  await openSettings(creator);
  await typeInto(creator, '#pc-proj-name', NAME);
  await creator.click('[data-pc="collab-toggle"]');
  await creator.waitForSelector('[data-pc="collab-where-hosted"]', { visible: true });
  const creatorPw = await creator.$eval('#pc-collab-cpw', (i) => i.value);
  const projectPw = await creator.$eval('#pc-collab-ppw', (i) => i.value);
  await creator.click('[data-pc="collab-where-hosted"]');
  await typeInto(creator, '[data-pc="collab-hosted-url"]', DOC);
  await creator.click('.pc-dialog-foot .pc-btn--primary');
  const status = await waitFor(async () => {
    const t = await textOf(creator, '[data-pc="collab-status"]');
    return t && !t.includes('正在设置') ? t : null;
  }, 40_000, '开启结果');
  check('S0.collab-enabled', status.includes('多用户协作已开启。'), { status });
  await creator.waitForSelector(SEL.streams, { visible: true, timeout: 15_000 }).catch(() => {});

  // S1 创建者看到这一行
  const c0 = await boxState(creator, SEL.streams);
  const b0 = await streamsBlock(creator);
  check('S1.creator-sees-row-default-unchecked-editable', !!c0 && c0.checked === false && c0.disabled === false, { box: c0 });
  check('S1.indented-under-render-node', !!b0 && b0.nestedInRender && b0.indent >= 16 && b0.state === 'off' && b0.opacity === 1 && b0.text.includes('生成轨道流')
    && b0.text.includes('没有打开：托管方的渲染节点不为这个项目生成轨道流，播放时用成员们各自设备生成的轨道流。打开后托管方也会生成，重卡在在线浏览器里播放更流畅，会多用云端的渲染时间。')
    && !b0.text.includes('暂不生效'), b0 ?? {});
  await shotCollab(creator, 'off');
  const found = await lookupProject({ base: DOC, name: NAME });
  check('S1.project-on-hosted', !!found?.projectId, { projectId: found?.projectId });

  // S2 成员看到只读
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
  await member.waitForSelector(SEL.streams, { visible: true, timeout: 15_000 }).catch(() => {});
  const m0 = await boxState(member, SEL.streams);
  const mText = await textOf(member, '[data-pc="collab-hosted-render-streams-hint"]');
  check('S2.member-row-readonly', !!m0 && m0.checked === false && m0.disabled === true && mText.includes('只有创建者能改'), { box: m0, hint: mText });

  // S3 创建者勾上 → 成员跟着变，打开时不提示
  const dialogOn = await toggleStreams(creator, creatorPw);
  check('S3.confirm-dialog-text', dialogOn === '打开后，托管方的渲染节点会为这个项目生成轨道流。', { dialog: dialogOn });
  const cOn = await waitFor(async () => { const s = await boxState(creator, SEL.streams); return s && s.checked === true ? s : null; }, 8000, '创建者的勾选勾上');
  check('S3.creator-checked', !!cOn && cOn.disabled === false, { box: cOn });
  const mOn = await waitFor(async () => { const s = await boxState(member, SEL.streams); return s && s.checked === true ? s : null; }, 5000, '成员那一端跟着勾上').catch(() => null);
  await sleep(1200);
  const toastsOn = (await toastsOf(member)).filter((x) => x.includes('轨道流'));
  check('S3.member-follows-within-5s-no-toast-on-open', !!mOn && mOn.disabled === true && toastsOn.length === 0, { box: mOn, toasts: toastsOn });
  const bOn = await streamsBlock(creator);
  check('S3.on-state-and-hint', !!bOn && bOn.state === 'on' && bOn.text.includes('托管方的渲染节点为这个项目生成轨道流，重卡在在线浏览器里播放更流畅。') && !bOn.text.includes('没有打开'), bOn ?? {});
  await shotCollab(creator, 'on');

  // S4 创建者再取消 → 成员跟着变并收到提示
  const dialogOff = await toggleStreams(creator, creatorPw);
  check('S4.confirm-dialog-text', dialogOff === '关闭后，托管方的渲染节点不再为这个项目生成轨道流，已经生成的保留。', { dialog: dialogOff });
  await waitFor(async () => (await boxState(creator, SEL.streams))?.checked === false, 8000, '创建者的勾选取消');
  const mOff = await waitFor(async () => { const s = await boxState(member, SEL.streams); return s && s.checked === false ? s : null; }, 5000, '成员那一端跟着取消').catch(() => null);
  check('S4.member-follows-within-5s', !!mOff && mOff.disabled === true, { box: mOff });
  const toasts1 = await waitFor(async () => { const t = (await toastsOf(member)).filter((x) => x.includes('创建者关闭了轨道流')); return t.length ? t : null; }, 5000, '成员收到提示').catch(() => null);
  check('S4.member-toast', !!toasts1 && toasts1[0].includes('托管方的渲染节点不再为这个项目生成轨道流'), { toasts: toasts1 });

  // S5 再勾上；渲染节点那一行关掉：轨道流这一行置灰，说明后面带一句
  await toggleStreams(creator, creatorPw);
  await waitFor(async () => (await boxState(creator, SEL.streams))?.checked === true, 8000, '创建者勾回');
  const renderOffDialog = await toggleRender(creator, creatorPw);
  check('S5.render-off-dialog', renderOffDialog.includes('关闭后，托管方的渲染节点不再为这个项目做预渲染'), { dialog: renderOffDialog });
  const cDis = await waitFor(async () => { const s = await boxState(creator, SEL.streams); return s && s.disabled ? s : null; }, 8000, '创建者的轨道流置灰');
  const bDis = await streamsBlock(creator);
  check('S5.creator-streams-greyed-still-checked', !!cDis && cDis.checked === true && bDis?.state === 'disabled' && bDis.opacity < 1, { box: cDis, block: bDis });
  check('S5.hint-says-not-in-effect', !!bDis && bDis.text.includes('重卡在在线浏览器里播放更流畅。（渲染节点关着，暂不生效）'), { text: bDis?.text });
  await creator.click(SEL.streams).catch(() => {});
  await sleep(500);
  check('S5.greyed-row-not-clickable', !(await creator.$('[data-pc="creator-verify"]')), { note: '点置灰的勾选没有弹出创建者验证' });
  const mDis = await waitFor(async () => { const s = await streamsBlock(member); return s && s.state === 'disabled' ? s : null; }, 5000, '成员那一端也置灰').catch(() => null);
  check('S5.member-streams-greyed', !!mDis && mDis.opacity < 1 && mDis.text.includes('（渲染节点关着，暂不生效）'), mDis ?? {});
  await shotCollab(creator, 'disabled');

  // S6 渲染节点再打开：恢复可点，仍是勾着
  await toggleRender(creator, creatorPw);
  const cBack = await waitFor(async () => { const s = await boxState(creator, SEL.streams); return s && !s.disabled ? s : null; }, 8000, '轨道流恢复可点');
  const bBack = await streamsBlock(creator);
  check('S6.streams-enabled-again-and-still-on', cBack.checked === true && bBack?.state === 'on' && !bBack.text.includes('暂不生效'), { box: cBack, block: bBack, render: await boxState(creator, SEL.render) });
  const mBack = await waitFor(async () => { const s = await streamsBlock(member); return s && s.state === 'on' ? s : null; }, 5000, '成员那一端恢复').catch(() => null);
  check('S6.member-back-to-on', !!mBack, mBack ?? {});

  const errs = [...new Set([...creator.consoleErrors, ...member.consoleErrors])];
  check('S7.page-errors', errs.length === 0, { sample: errs.slice(0, 5) });
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
const fails = [...bad.map((r) => r.check), ...(failed ? ['probe.fatal'] : [])];
console.log(JSON.stringify({ summary: { ok: !failed && bad.length === 0, total: results.length, fails } }));
process.exit(!failed && bad.length === 0 ? 0 : 1);
