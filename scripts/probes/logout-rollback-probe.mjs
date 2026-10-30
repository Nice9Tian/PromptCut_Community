/**
 * 0.7.20 退出后的逐项撤回与撤销冲突:看得见的三样的截图探针(分支 claude/logout-rollback)。全程在本机,不连任何远端。
 *
 *   npx vite build --mode online
 *   node scripts/probes/logout-rollback-probe.mjs [--dist dist-online] [--out out/logout-rollback] [--site <VisuHive 仓库>/site]
 *        [--base-port 5980] [--base2-port 5983] [--doc-port 5986] [--asset-port 5987] [--site-port 5988] [--status <状态 JSON>]
 *
 * U1 撤销按钮走出来的冲突合并窗口:甲一步改了 c1 的透明度和名称,乙随后改了 c1 的透明度;甲按撤销 →
 *    名称(没人再改)直接撤回、乙那边看得到;透明度(乙改过)进「冲突合并」窗口,写「透明度 0.8 → 0.4(云端现在是 0.6)」。
 *    (本机托管组合 + 口令共享项目 + 在线构建,和 conflict-merge-probe 同一套环境。)
 * U2 项目里那条气泡:页面收到文档服务的 `shared.notice { event: 'content-rolled-back', name }` 后弹「〈用户名〉撤回了内容」。
 *    口令共享项目没有「改密后选退出」这条路,所以这条消息由探针在同一个本机托管组合上直接发给两位成员的页面连接
 *    (消息格式与账号云端项目里文档服务发的一字不差,见 `server/docservice/modules/project.mjs` 的 `rollback`);
 *    谁收得到(在线成员、不在线的不补)由 `server/test/account-logout-rollback.test.mjs` LR-E1 在真的账号云端项目里证明。
 * U3 官网改密 / 重设密码页面「设备已退出」下面那一行:VisuHive 的 `site/`(网页文件原样)由本机静态服务给出,
 *    `/api/account` 只回放 LR-E1 跑出来的那份真状态(`--status`,缺省是一份同形的样例)。
 * 结果最后一行是一行 JSON;截图写进 --out。
 */
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { startMobileEnv } from './lib/mobile-env.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.resolve(arg('--dist', path.join(ROOT, 'dist-online')));
const OUT = path.resolve(arg('--out', path.join(ROOT, 'out', 'logout-rollback')));
// 规范化：Windows 上 path.join 回的是反斜杠，命令行给正斜杠时下面那道 file.startsWith(SITE) 的目录逃逸防护会永远不匹配、
// 把所有请求判成 404（2026-10-23 踩到）。两边都过 path.resolve 就不受分隔符写法影响。
const SITE_RAW = arg('--site', process.env.PROMPTCUT_ACCOUNT_PROVIDER_ROOT ? path.join(process.env.PROMPTCUT_ACCOUNT_PROVIDER_ROOT, 'site') : null);
const SITE = SITE_RAW ? path.resolve(SITE_RAW) : null;
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

const project = {
  version: 1, id: `rollback-probe-${Date.now().toString(36)}`, name: '撤回演示', width: 1920, height: 1080, fps: 30, duration: 12, themeId: 'midnight', media: [],
  tracks: [{ id: 't-1', name: '序列 1', clips: [
    { id: 'c1', cardId: 'mu-blur-fade', start: 0, end: 2, params: {}, opacity: 0.4, label: '开场' },
    { id: 'c2', cardId: 'mu-typing', start: 2.5, end: 4.5, params: {}, label: '打字' },
  ] }],
  cuts: [{ id: 'cut-1', name: '剪辑 1' }], activeCutId: 'cut-1',
};

const pageConns = [];
const env = await startMobileEnv({
  dist: DIST, basePort: Number(arg('--base-port', 5980)), base2Port: Number(arg('--base2-port', 5983)),
  docPort: Number(arg('--doc-port', 5986)), assetPort: Number(arg('--asset-port', 5987)), name: `rollback-probe-${Date.now().toString(36)}`,
  log: (event, fields) => { if (event === 'conn.open' && fields?.role === 'page') pageConns.push(fields.connId); },
});
const browser = await puppeteer.launch({ headless: true, protocolTimeout: 600_000, args: [...PROBE_CHROME_ARGS, '--no-first-run', '--window-position=-32000,-32000'] });
let siteServer = null;
try {
  const seeded = await env.seed(project);
  check(!/error|reject/i.test(`${seeded.opened}${seeded.seeded}`), '替创建者写进初始项目', seeded);
  const A = await env.newPage(browser, 'desktop');
  await env.enter(A, { layout: 'desktop', username: 'jia' });
  const B = await env.newPage(browser, 'desktop');
  await env.enter(B, { layout: 'desktop', username: 'yi', via: 2 });
  await until('甲乙都看到两段', async () => (await clipOf(A, 'c2')) && (await clipOf(B, 'c2')), 60_000);
  await sleep(1500);

  /* ---------------- U1 撤销 → 冲突合并窗口 ---------------- */
  await store(A, 'S.actions.updateClip("c1", { opacity: 0.8, label: "开场（甲改）" }); return true;');
  await until('乙看到甲的修改', async () => (await clipOf(B, 'c1'))?.opacity === 0.8, 20_000);
  await store(B, 'S.actions.updateClip("c1", { opacity: 0.6 }); return true;');
  await until('甲看到乙的修改', async () => (await clipOf(A, 'c1'))?.opacity === 0.6, 20_000);
  await sleep(500);
  await store(A, 'S.actions.undo(); return true;');
  const win = await until('冲突合并窗口打开', () => A.$('[data-pc="conflict-merge"]'), 20_000);
  await A.evaluate(() => { for (const li of document.querySelectorAll('[data-pc="merge-thing"]')) { const b = li.querySelector('.pc-merge-expand'); if (b?.getAttribute('aria-expanded') === 'false') b.click(); } });
  await sleep(400);
  const rows = await A.evaluate(() => [...document.querySelectorAll('[data-pc="merge-thing"]')].map((li) => ({
    key: li.getAttribute('data-key'), props: [...li.querySelectorAll('[data-pc="merge-prop"]')].map((p) => p.innerText.replace(/\s+/g, ' ').trim()) })));
  const bC1 = await until('乙看到名称撤回了', async () => { const c = await clipOf(B, 'c1'); return c?.label === '开场' ? c : null; }, 20_000);
  const undoBar = await A.$('[data-pc="undo-notice"]');
  step('U1', { open: !!win, rows, bC1: bC1 && { label: bC1.label, opacity: bC1.opacity }, undoBar: !!undoBar });
  check(!!win, 'U1 撤销遇到冲突时弹出冲突合并窗口');
  check(rows.length === 1 && rows[0].key === 'undo:clip:c1' && rows[0].props.length === 1 && rows[0].props[0].includes('透明度 0.8 → 0.4（云端现在是 0.6）'),
    'U1 窗口里只有真冲突的那一项,写明落地后 → 撤回后、云端现在是什么', rows);
  check(bC1 && bC1.opacity === 0.6, 'U1 没冲突的名称直接撤回、乙看得到;乙改的透明度不动', bC1);
  check(!undoBar, 'U1 冲突进了窗口,不再弹撤销提示条');
  await shot(A, 'undo-merge-window');
  // 合并:照撤回后的值写
  await A.evaluate(() => document.querySelector('[data-pc="merge-select-clean"]')?.click());
  await A.evaluate(() => { const box = document.querySelector('[data-pc="merge-prop"] input'); if (box && !box.checked) box.click(); });
  await sleep(200);
  await A.evaluate(() => document.querySelector('[data-pc="merge-apply"]')?.click());
  const merged = await until('乙看到透明度照甲撤回后的值', async () => { const c = await clipOf(B, 'c1'); return c?.opacity === 0.4 ? c : null; }, 20_000);
  step('U1-merge', { merged: merged && { label: merged.label, opacity: merged.opacity }, note: await textOf(A, '[data-pc="merge-note"]') });
  await shot(A, 'undo-merge-applied');
  await A.evaluate(() => document.querySelector('[data-pc="merge-close"]')?.click());
  await sleep(400);

  /* ---------------- U2 气泡 ---------------- */
  const notice = { type: 'shared.notice', event: 'content-rolled-back', projectId: env.made.projectId, name: '小王' };
  for (const connId of pageConns) env.combo.service.send(connId, notice);
  const toast = await until('甲看到气泡', () => A.evaluate(() => [...document.querySelectorAll('[role="status"], .pc-toast, [data-pc="toast"]')]
    .map((e) => e.innerText).find((t) => t.includes('撤回了内容')) ?? null), 10_000);
  const toastB = await until('乙看到气泡', () => B.evaluate(() => document.body.innerText.includes('小王撤回了内容')), 10_000);
  step('U2', { pageConns: pageConns.length, toast, toastB });
  check(toast && toast.includes('小王撤回了内容'), 'U2 页面弹「〈用户名〉撤回了内容」', toast);
  await shot(A, 'rollback-bubble');

  /* ---------------- U3 官网那一行 ---------------- */
  if (!SITE || !fs.existsSync(path.join(SITE, 'account.html'))) fails.push('U3 没给 VisuHive 的 site 目录(--site 或 PROMPTCUT_ACCOUNT_PROVIDER_ROOT)');
  else {
    const statusFile = arg('--status', null);
    const done = statusFile ? JSON.parse(fs.readFileSync(statusFile, 'utf8')) : { eventId: 'pw_sample', passwordEventId: 'pw_sample', choice: 'exit', state: 'complete',
      logout: { state: 'complete', pendingServices: [], pendingEvidence: [], endOrderSeq: 7 }, modifications: { state: 'rolled-back', version: '0.7.20', reverted: 1, kept: 1 } };
    const event = { ...done, ok: true };
    const revoking = { ...event, state: 'revoking', logout: { state: 'revoking', pendingServices: ['doc'], pendingEvidence: [] } };
    const api = { '/me': { ok: true, account: { id: 'acc_sample', name: '小王', email: null, createdAt: 1 }, csrfToken: 'probe-csrf', pendingPasswordEvents: [revoking] },
      '/projects': { ok: true, owned: [], joined: [] } };
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
    siteServer = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      if (url.pathname.startsWith('/api/account')) {
        const route = url.pathname.slice('/api/account'.length);
        const body = route.startsWith('/password-events/') ? event : api[route] ?? { ok: false, code: 'not-found' };
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); return;
      }
      const name = url.pathname === '/' ? 'index.html' : url.pathname.endsWith('.html') || url.pathname.includes('.') ? url.pathname.slice(1) : `${url.pathname.slice(1)}.html`;
      const file = path.join(SITE, name);
      if (!file.startsWith(SITE) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' }); res.end(fs.readFileSync(file));
    });
    const sitePort = Number(arg('--site-port', 5988));
    await new Promise((resolve) => siteServer.listen(sitePort, '127.0.0.1', resolve));
    const W = await browser.newPage();
    await W.setViewport({ width: 900, height: 700 });
    await W.goto(`http://127.0.0.1:${sitePort}/account`, { waitUntil: 'networkidle0' });
    // 网页先读到「正在退出」,隔几秒再读一次状态时读到办完(这里直接点「重新读取状态」)
    await W.evaluate(() => document.querySelector('#password-event-refresh')?.click());
    const line = await until('网页显示那一行', () => W.evaluate(() => { const e = document.querySelector('#password-event-modifications'); return e && !e.hidden ? e.innerText : null; }), 10_000);
    const status = await W.evaluate(() => document.querySelector('#password-event-status')?.innerText ?? null);
    step('U3', { status, line, from: statusFile ? 'LR-E1 状态' : '样例' });
    check(status === '设备已退出', 'U3 「设备已退出」', status);
    check(line === `旧设备在改密码后做的 ${done.modifications.reverted} 处修改已撤回；${done.modifications.kept} 处已被别人接着改过，保留。`, 'U3 那一行照用户定的原文', line);
    await W.evaluate(() => document.querySelector('#password-event')?.scrollIntoView({ block: 'center' }));
    await shot(W, 'website-line');
    // U3b 超过一次能处理的上限:三个数分开说(数字取 RB-05 那一局:撤 450、别人改过 0、超限 50)
    Object.assign(event, { modifications: { state: 'rolled-back', version: '0.7.20', reverted: 450, kept: 0, overLimit: 50 } });
    await W.goto(`http://127.0.0.1:${sitePort}/account`, { waitUntil: 'networkidle0' });
    await W.evaluate(() => document.querySelector('#password-event-refresh')?.click());
    const over = await until('网页显示超限那一句', () => W.evaluate(() => { const e = document.querySelector('#password-event-modifications'); return e && !e.hidden && e.innerText.includes('另有') ? e.innerText : null; }), 10_000);
    step('U3b', { line: over });
    check(over === '旧设备在改密码后做的 450 处修改已撤回；0 处已被别人接着改过，保留。另有 50 处这次没有撤回：一次能处理的修改数量到了上限，不是别人改过；这些内容仍在项目里，没有丢。',
      'U3b 超过上限的单独一句', over);
    await W.evaluate(() => document.querySelector('#password-event')?.scrollIntoView({ block: 'center' }));
    await shot(W, 'website-line-over-limit');
  }
  out.errors = { A: A.errors, B: B.errors };
} catch (e) {
  fails.push(`异常:${e?.stack ?? e}`);
} finally {
  await browser.close().catch(() => {});
  await new Promise((resolve) => siteServer ? siteServer.close(resolve) : resolve());
  await env.close();
}
out.ok = fails.length === 0;
out.fails = fails;
out.shots = shots;
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
