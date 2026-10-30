/**
 * 冲突合并窗口的验收探针(0.7.19,分支 claude/conflict-merge):桌面界面与手机界面各走一遍,截图。
 * 全程在本机:本机托管组合 + 仿 nginx 的两套代理(`lib/mobile-env.mjs`),在线构建当页面,不连任何远端。
 *
 *   npx vite build --mode online
 *   node scripts/probes/conflict-merge-probe.mjs [--dist dist-online] [--out out/conflict-merge] [--base-port 5890] [--base2-port 5893] [--doc-port 5896] [--asset-port 5897]
 *
 * 角色:甲(桌面界面,走第一套代理)、乙(另一名成员,走第二套代理)、甲的手机(同一用户「甲」,手机界面,第一套代理)。
 *   D1 只断甲:甲断网期间改 c1 透明度两次与长度、改 c4 名字、删 c2;乙同时改 c1 透明度、改 c2、删 c4
 *   D2 甲连回:离线批次逐项转进待合并表,冲突合并窗口自己打开;一级按东西(c1、c2、c4)、二级按属性(c1 透明度只一条)
 *   D3 「选中无冲突项」只勾上 c1 的长度;点「合并」:乙那边看到长度变了、透明度仍是乙的
 *   D4 「下次再说」关窗:导航栏顶端的「冲突合并」按钮还在
 *   D5 甲的手机(同一用户)进项目:冲突横条显示同一张表(待合并表存在文档服务、按项目 × 用户);面板里逐项勾选、合并、删除选中,
 *      处理完横条收起,桌面那边的「冲突合并」按钮也跟着消失
 *   D6 在线浏览器断网时「导入媒体」置灰、提示「当前离线」(桌面与手机)
 * 结果最后一行是一行 JSON;截图写进 --out。
 */
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { startMobileEnv } from './lib/mobile-env.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.resolve(arg('--dist', path.join(ROOT, 'dist-online')));
const OUT = path.resolve(arg('--out', path.join(ROOT, 'out', 'conflict-merge')));
fs.mkdirSync(OUT, { recursive: true });

const fails = [];
const out = { ok: false, out: OUT, steps: {} };
const step = (k, v) => { out.steps[k] = v; console.log(JSON.stringify({ step: k, ...((v && typeof v === 'object') ? v : { v }) })); };
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
const shots = [];
const shot = async (page, name) => { const f = path.join(OUT, `${name}.png`); await page.screenshot({ path: f }).catch(() => {}); shots.push(f); };
const store = (page, src, ...a) => page.evaluate((s, a2) => new Function('S', 'args', s)(window.__pcStore, a2), src, a);
const clipOf = (page, id) => store(page, 'return S.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === args[0]) ?? null;', id);
const textOf = (page, sel) => page.evaluate((s) => document.querySelector(s)?.innerText ?? null, sel);
const clickSel = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e || e.disabled) return false; e.click(); return true; }, sel);
const tap = async (page, sel) => {
  const r = await page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const q = e.getBoundingClientRect(); return { x: q.x + q.width / 2, y: q.y + q.height / 2 }; }, sel);
  if (!r) throw new Error(`点不到 ${sel}`);
  await page.touchscreen.tap(r.x, r.y);
  await sleep(350);
};

const project = {
  version: 1, id: `merge-probe-${Date.now().toString(36)}`, name: '冲突合并演示', width: 1920, height: 1080, fps: 30, duration: 12, themeId: 'midnight', media: [],
  tracks: [{ id: 't-1', name: '序列 1', clips: [
    { id: 'c1', cardId: 'mu-blur-fade', start: 0, end: 2, params: {}, opacity: 0.4, label: '开场' },
    { id: 'c2', cardId: 'mu-typing', start: 2.5, end: 4.5, params: {}, label: '打字' },
    { id: 'c3', cardId: 'blur-text', start: 5, end: 7, params: {}, label: '标语' },
    { id: 'c4', cardId: 'checklist', start: 7.5, end: 9.5, params: {}, label: '清单' },
  ] }],
  cuts: [{ id: 'cut-1', name: '剪辑 1' }], activeCutId: 'cut-1',
};

const env = await startMobileEnv({
  dist: DIST, basePort: Number(arg('--base-port', 5890)), base2Port: Number(arg('--base2-port', 5893)),
  docPort: Number(arg('--doc-port', 5896)), assetPort: Number(arg('--asset-port', 5897)), name: `merge-probe-${Date.now().toString(36)}`,
});
const browser = await puppeteer.launch({ headless: true, protocolTimeout: 600_000, args: [...PROBE_CHROME_ARGS, '--no-first-run', '--window-position=-32000,-32000'] });
try {
  const seeded = await env.seed(project);
  check(!/error|reject/i.test(`${seeded.opened}${seeded.seeded}`), '替创建者写进初始项目', seeded);

  const A = await env.newPage(browser, 'desktop');
  await env.enter(A, { layout: 'desktop', username: 'jia' });
  const B = await env.newPage(browser, 'desktop');
  await env.enter(B, { layout: 'desktop', username: 'yi', via: 2 });
  await until('甲乙都看到四段', async () => (await clipOf(A, 'c4')) && (await clipOf(B, 'c4')), 60_000);
  await sleep(1500);

  /* ---------------- D1 只断甲 ---------------- */
  env.proxy.cutWs();
  await sleep(800);
  await store(A, 'S.actions.updateClip("c1", { opacity: 0.6 }); return true;');
  await sleep(200);
  await store(A, 'S.actions.updateClip("c1", { opacity: 0.9 }); return true;');
  await store(A, 'S.actions.updateClip("c4", { label: "清单（甲改）" }); return true;');
  await store(A, 'S.actions.removeClip("c2"); return true;');
  // 改 c1 的长度:直接改结束时间(同 moveClip 的一次改动)
  await store(A, 'S.actions.moveClip("c1", { start: 0, end: 2.4 }); return true;');
  const unsent = await until('甲判成离线且有未提交的修改', () => A.$('[data-pc="offline-unsent"]'), 150_000, 500);
  step('D1-offline', { unsent: !!unsent, text: unsent ? await textOf(A, '[data-pc="offline-unsent"]') : null });
  await shot(A, 'desktop-0-offline');
  // 断网时导入媒体置灰(D6 桌面)
  const importBtn = await A.evaluate(() => { const b = document.querySelector('[data-pc-add="media"]'); return b ? { disabled: b.disabled, text: b.innerText, title: b.title } : null; });
  step('D6-desktop-import', importBtn);
  check(importBtn?.disabled && /当前离线/.test(importBtn.text), 'D6 桌面断网时导入媒体置灰、提示当前离线', importBtn);
  await shot(A, 'desktop-6-import-offline');
  await store(B, 'S.actions.updateClip("c1", { opacity: 0.7 }); return true;');
  await store(B, 'S.actions.updateClip("c2", { label: "打字（乙改）" }); return true;');
  await store(B, 'S.actions.removeClip("c4"); return true;');
  await sleep(2000);

  /* ---------------- D2 甲连回:窗口自己打开 ---------------- */
  env.proxy.blockWs = false;
  const win = await until('冲突合并窗口打开', () => A.$('[data-pc="conflict-merge"]'), 150_000, 500);
  await sleep(800);
  const rows = await A.evaluate(() => [...document.querySelectorAll('[data-pc="merge-thing"]')].map((li) => ({
    key: li.getAttribute('data-key'), head: li.querySelector('.pc-merge-thing-head')?.innerText.replace(/\s+/g, ' '),
    props: [...li.querySelectorAll('[data-pc="merge-prop"]')].map((p) => p.innerText.replace(/\s+/g, ' ')),
  })));
  step('D2-rows', { open: !!win, summary: await textOf(A, '[data-pc="merge-summary"]'), rows });
  const keys = rows.map((r) => r.key).sort();
  check(JSON.stringify(keys) === JSON.stringify(['offline:clip:c1', 'offline:clip:c2', 'offline:clip:c4']), 'D2 一级按东西:c1、c2、c4 各一条', keys);
  // 展开 c1 看二级
  await A.evaluate(() => { for (const li of document.querySelectorAll('[data-pc="merge-thing"]')) { const b = li.querySelector('.pc-merge-expand'); if (b?.getAttribute('aria-expanded') === 'false') b.click(); } });
  await sleep(300);
  const c1Props = await A.evaluate(() => [...document.querySelectorAll('[data-pc="merge-thing"][data-key="offline:clip:c1"] [data-pc="merge-prop"]')].map((p) => p.innerText.replace(/\s+/g, ' ').trim()));
  step('D2-c1-props', { c1Props });
  check(c1Props.length === 2 && c1Props.some((t) => t.includes('透明度 0.4 → 0.9（云端现在是 0.7）')) && c1Props.some((t) => t.startsWith('时间')), 'D2 c1 二级:透明度只一条(改两次)、时间一条,写明云端现在是什么', c1Props);
  await shot(A, 'desktop-1-window');

  /* ---------------- D3 选中无冲突项 → 合并 ---------------- */
  await clickSel(A, '[data-pc="merge-select-clean"]');
  await sleep(300);
  const picked = await A.evaluate(() => [...document.querySelectorAll('[data-pc="merge-prop"] input:checked')].map((i) => i.closest('[data-pc="merge-prop"]').innerText.replace(/\s+/g, ' ').trim()));
  step('D3-picked', { picked });
  check(picked.length === 1 && picked[0].startsWith('时间'), 'D3 选中无冲突项只勾上 c1 的长度', picked);
  await shot(A, 'desktop-2-select-clean');
  await clickSel(A, '[data-pc="merge-apply"]');
  await sleep(1500);
  const note = await textOf(A, '[data-pc="merge-note"]');
  const bC1 = await until('乙看到 c1 长度变了', async () => { const c = await clipOf(B, 'c1'); return c && c.end === 2.4 ? c : null; }, 20_000);
  const statusChip = await textOf(A, '[data-pc="sync-online-status"]');
  step('D3-merged', { note, bC1: bC1 && { end: bC1.end, opacity: bC1.opacity }, statusChip });
  check(!statusChip || !statusChip.includes('已全部提交'), 'D2 离线修改转进待合并表后,顶栏不说「离线时的修改已全部提交」', statusChip);
  check(bC1 && bC1.opacity === 0.7, 'D3 合并后:长度照甲、透明度仍是乙的', bC1);
  await shot(A, 'desktop-3-merged');

  /* ---------------- D4 下次再说 → 导航栏按钮 ---------------- */
  await clickSel(A, '[data-pc="merge-close"]');
  await sleep(500);
  const navBtn = await textOf(A, '[data-pc="conflict-merge-open"]');
  step('D4-nav-button', { navBtn });
  check(!!navBtn && navBtn.includes('冲突合并'), 'D4 关窗后导航栏顶端仍有「冲突合并」按钮', navBtn);
  await shot(A, 'desktop-4-nav-button');

  /* ---------------- D5 同一用户的手机 ---------------- */
  const M = await env.newPage(browser, 'phone');
  await env.enter(M, { layout: 'mobile', username: 'jia' });
  const bar = await until('手机的冲突横条', () => M.$('[data-pcm="cfbar"]'), 60_000, 500);
  step('D5-bar', { bar: bar ? await textOf(M, '[data-pcm="cfbar-text"]') : null });
  check(!!bar, 'D5 同一用户在手机上看到同一张待合并表(冲突横条)');
  await shot(M, 'mobile-1-bar');
  // 进项目时的气泡(「已切换低内存模式」之类)会盖住横条右侧的「处理」,点不着就直接点元素
  await tap(M, '[data-pcm="cfbar-open"]');
  if (!(await M.$('[data-pcm="sheet-conflict"]'))) await clickSel(M, '[data-pcm="cfbar-open"]');
  await M.waitForSelector('[data-pcm="sheet-conflict"]', { visible: true, timeout: 20_000 });
  await sleep(500);
  const mRows = await M.evaluate(() => [...document.querySelectorAll('[data-pcm="cf-thing"]')].map((g) => ({ key: g.getAttribute('data-key'), text: g.innerText.replace(/\s+/g, ' ') })));
  step('D5-sheet', { mRows });
  check(mRows.length === 3, 'D5 手机面板一级三条(c1 剩透明度、c2、c4)', mRows);
  await shot(M, 'mobile-2-sheet');
  // 勾上 c4(我改了、别人删了)整条 → 合并 = 连同我的修改恢复
  await M.evaluate(() => document.querySelector('[data-pcm="cf-thing"][data-key="offline:clip:c4"] .cf-head input')?.click());
  await sleep(300);
  await shot(M, 'mobile-3-picked');
  await tap(M, '[data-pcm="cf-merge"]');
  const restored = await until('乙看到 c4 恢复回来', async () => { const c = await clipOf(B, 'c4'); return c && c.label === '清单（甲改）' ? c : null; }, 20_000);
  step('D5-restored', { restored: restored && { label: restored.label }, note: await textOf(M, '[data-pcm="cf-note"]') });
  // 剩下的(c1 透明度、c2 删除)全勾 → 删除选中:云端保持现状
  await M.evaluate(() => { for (const i of document.querySelectorAll('[data-pcm="cf-thing"] .cf-head input')) if (!i.checked) i.click(); });
  await sleep(300);
  await tap(M, '[data-pcm="cf-drop"]');
  await sleep(1200);
  const doneText = await textOf(M, '[data-pcm="cf-close"]');
  step('D5-done', { close: doneText });
  check(doneText === '完成', 'D5 清空后关闭按钮变成「完成」', doneText);
  await shot(M, 'mobile-4-done');
  const bC2 = await clipOf(B, 'c2');
  check(bC2 && bC2.label === '打字（乙改）', 'D5 删除选中:c2 保留云端现状(乙改过的那版)', bC2);
  await tap(M, '[data-pcm="cf-close"]');
  const barGone = await until('手机横条收起', async () => !(await M.$('[data-pcm="cfbar"]')), 20_000);
  const navGone = await until('桌面的「冲突合并」按钮跟着消失', async () => !(await A.$('[data-pc="conflict-merge-open"]')), 20_000);
  step('D5-cleared', { barGone: !!barGone, navGone: !!navGone });
  await shot(M, 'mobile-5-cleared');
  await shot(A, 'desktop-5-cleared');

  /* ---------------- D6 手机断网时导入置灰 ---------------- */
  env.proxy.cutWs();
  await until('手机判成离线', () => M.evaluate(() => document.querySelector('[data-pc="offline-unsent"]') !== null || true), 5_000);
  await sleep(6000);
  await tap(M, '[data-pcm="sub-image"]').catch(() => {});
  await M.waitForSelector('[data-pcm="sheet-assets"]', { visible: true, timeout: 20_000 }).catch(() => {});
  const mImport = await until('手机导入按钮置灰', async () => {
    const r = await M.evaluate(() => { const b = document.querySelector('[data-pcm="import"]'); return b ? { disabled: b.disabled, text: b.innerText } : null; });
    return r?.disabled ? r : null;
  }, 60_000, 500);
  const dropzone = await M.evaluate(() => { const b = document.querySelector('[data-pcm="import-dropzone"]'); return b ? { disabled: b.disabled, text: b.innerText } : null; });
  step('D6-mobile-import', { head: mImport, dropzone });
  check(mImport && /当前离线/.test(mImport.text), 'D6 手机断网时导入置灰、提示当前离线', mImport);
  check(!dropzone || (dropzone.disabled && /当前离线/.test(dropzone.text)), 'D6 手机素材库空白处的导入同样置灰', dropzone);
  await shot(M, 'mobile-6-import-offline');
  env.proxy.blockWs = false;

  out.errors = { A: A.errors, M: M.errors };
} catch (e) {
  fails.push(`异常:${e?.stack ?? e}`);
} finally {
  await browser.close().catch(() => {});
  await env.close();
}
out.ok = fails.length === 0;
out.fails = fails;
out.shots = shots;
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
