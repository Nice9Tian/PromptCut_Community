/**
 * C10a 在线页面的探针（`docs/plan/c10a-contract.md` 第 2 节「在线页面不请求 /api/*」、第 4 节「读邀请码」、
 * 第 12 节「`/api` 守卫：在线构建里没有 `/api/` 请求」）。测试方写，只照契约，不看实现。
 *
 * 用法：
 *   node scripts/probes/c10a-online-probe.mjs [--dist <在线构建目录>] [--port 5650] [--out <截图目录>] [--headful] [--force]
 *
 * - 没给 `--dist` 就自己跑一次 `vite build --mode online`，产物放临时目录（不碰 `dist-online/`）。
 * - 探针自己起一个静态服务（缺省 127.0.0.1:5650，C10a 测试方的端口段 5650～5659），照契约第 2 节 nginx 的形状：
 *   `/editor`、`/editor/index.html` 回 index.html（no-store），`/editor/assets/*` 找不到回 404，`/editor/*` 其余回落 index.html。
 *   `/hosted/shared/invite/resolve|redeem` 由探针假扮（按场景回失效或项目名），记下请求体；其余 `/hosted`、`/media`、`/api`
 *   一律 404 并记账，WebSocket 升级直接断开。不连任何真正的托管端。
 * - 浏览器按 Chrome 移动端仿真打开（390×844、触屏、Android UA、注入 `navigator.deviceMemory = 4`）。
 * - 场景（每项一行 JSON `{ check, ok, ... }`，最后一行 `{ summary }`；有失败退出码 1；`src/online/mode.ts` 不在时退出码 2，
 *   `--force` 照跑，用来查探针自己的管路）：
 *     S1 开 `/editor`：静置 4 s，同源没有任何 `/api/` 请求；控制台没有提到 `/api/` 的错误；`/editor/assets/` 的请求全是 200。
 *     S2 开 `/editor#invite=<失效码>`：5 s 内向同源 `…/shared/invite/resolve` 提交一次，码在请求体里、不在任何地址里；
 *        `#` 片段被清掉；localStorage / sessionStorage 里没有这个码；页面出现表 A「这个邀请链接已失效」。
 *     S3 开 `/editor#invite=<有效码>`：resolve 回项目名，页面上出现这个项目名。
 *     S4 开 `/editor#invite=<长度不对的码>`：3 s 内不发 resolve（字符集与长度先核对）。
 *     S5 开 `/editor/some/deep/route`：页面照常起来（SPA 回落 + `base: '/editor/'`），同源没有 `/api/` 请求。
 *   截图写进 `--out`（缺省 `out/c10a-online-probe`）：`s1-start.png`、`s2-invalid.png`、`s3-valid.png`、`s5-deep.png`。
 */
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def; };
const flag = (name) => argv.includes(`--${name}`);

const PORT = Number(arg('port', '5650'));
if (PORT < 5650 || PORT > 5659) console.error(`[c10a-online-probe] 注意：端口 ${PORT} 不在测试方的端口段 5650～5659 里`);
const OUT = path.resolve(ROOT, arg('out', 'out/c10a-online-probe'));
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const report = (check, ok, extra = {}) => { const r = { check, ok, ...extra }; results.push(r); console.log(JSON.stringify(r)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(path.join(ROOT, 'src', 'online', 'mode.ts')) && !flag('force')) {
  console.log(JSON.stringify({ summary: { ok: false, missing: '接口缺失：src/online/mode.ts 不在（C10a 在线构建未集成）；加 --force 只查探针管路' } }));
  process.exit(2);
}

// ------------------------------------------------------------------ 构建

let dist = arg('dist');
let tmpDist = null;
if (!dist) {
  tmpDist = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-c10a-probe-'));
  dist = path.join(tmpDist, 'dist-online');
  const { build } = await import('vite');
  process.chdir(ROOT);
  const t0 = Date.now();
  await build({ root: ROOT, mode: 'online', logLevel: 'error', build: { outDir: dist, emptyOutDir: true, reportCompressedSize: false } });
  report('build', true, { mode: 'online', ms: Date.now() - t0, outDir: dist });
}
dist = path.resolve(dist);
const INDEX = path.join(dist, 'index.html');
if (!fs.existsSync(INDEX)) { report('build', false, { error: `没有 ${INDEX}` }); process.exit(1); }

// ------------------------------------------------------------------ 静态服务 + 假托管端

const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.webp': 'image/webp' };
const server = { log: [], invite: { mode: 'invalid', name: '' }, bodies: [] };
const readBody = (req) => new Promise((resolve) => { const parts = []; req.on('data', (d) => parts.push(d)); req.on('end', () => resolve(Buffer.concat(parts).toString('utf8'))); req.on('error', () => resolve('')); });
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(body)); };

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const p = decodeURIComponent(url.pathname);
  server.log.push({ method: req.method, path: p, search: url.search });
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' }); return res.end(); }
  const invite = /^(?:\/hosted)?\/shared\/invite\/(resolve|redeem)$/.exec(p);
  if (invite) {
    const text = await readBody(req);
    let body = null;
    try { body = JSON.parse(text); } catch { /* 不是 JSON */ }
    server.bodies.push({ ep: invite[1], path: p, body });
    if (server.invite.mode === 'valid' && invite[1] === 'resolve') return json(res, 200, { ok: true, projectId: 'sp_probeprobeprobeprobeprobepr', name: server.invite.name, mode: 'free' });
    return json(res, 404, { ok: false, error: 'invite-invalid' });
  }
  if (p === '/editor' || p === '/editor/' || p === '/editor/index.html') {
    res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
    return res.end(fs.readFileSync(INDEX));
  }
  if (p.startsWith('/editor/')) {
    const rel = p.slice('/editor/'.length);
    const file = path.join(dist, rel);
    if (file.startsWith(dist) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      const immutable = rel.startsWith('assets/');
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-store', 'X-Content-Type-Options': 'nosniff' });
      return res.end(fs.readFileSync(file));
    }
    if (rel.startsWith('assets/')) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(INDEX));
  }
  return json(res, 404, { ok: false, error: 'probe-not-found' });
});
httpServer.on('upgrade', (req, socket) => { server.log.push({ method: 'UPGRADE', path: req.url }); socket.destroy(); });
await new Promise((resolve, reject) => { httpServer.once('error', reject); httpServer.listen(PORT, '127.0.0.1', resolve); });
const ORIGIN = `http://127.0.0.1:${PORT}`;

// ------------------------------------------------------------------ 浏览器

const browser = await puppeteer.launch({
  headless: !flag('headful'),
  args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1'],
});
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36';

async function openPage() {
  const page = await browser.newPage();
  await page.setUserAgent(MOBILE_UA);
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(Navigator.prototype, 'deviceMemory', { get: () => 4, configurable: true });
  });
  const rec = { requests: [], responses: [], console: [], errors: [] };
  page.on('request', (r) => rec.requests.push({ url: r.url(), method: r.method(), body: r.postData() ?? null }));
  page.on('response', (r) => rec.responses.push({ url: r.url(), status: r.status() }));
  page.on('console', (m) => rec.console.push({ type: m.type(), text: m.text() }));
  page.on('pageerror', (e) => rec.errors.push(String(e?.message ?? e)));
  return { page, rec };
}

const sameOriginPath = (u) => { try { const x = new URL(u); return x.origin === ORIGIN ? x.pathname : null; } catch { return null; } };
const apiRequests = (rec) => rec.requests.filter((r) => (sameOriginPath(r.url) ?? '').startsWith('/api/'));
const apiConsole = (rec) => [...rec.console.filter((c) => c.type === 'error').map((c) => c.text), ...rec.errors].filter((t) => t.includes('/api/'));
const bodyText = (page) => page.evaluate(() => document.body?.innerText ?? '');
async function waitText(page, needle, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if ((await bodyText(page)).includes(needle)) return true; await sleep(200); }
  return false;
}
async function waitFor(pred, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(100); }
  return !!pred();
}
const code43 = () => randomBytes(32).toString('base64url');

try {
  // S1 开始页不请求 /api/
  {
    const { page, rec } = await openPage();
    await page.goto(`${ORIGIN}/editor`, { waitUntil: 'load', timeout: 30_000 }).catch((e) => rec.errors.push(`goto: ${e.message}`));
    await sleep(4000);
    await page.screenshot({ path: path.join(OUT, 's1-start.png') });
    const api = apiRequests(rec);
    const loaded = rec.responses.some((r) => (sameOriginPath(r.url) ?? '').startsWith('/editor/assets/') && r.status === 200);
    report('S1 开始页没有 /api/ 请求', loaded && api.length === 0, { loaded, api: api.slice(0, 10) });
    const cons = apiConsole(rec);
    report('S1 控制台没有提到 /api/ 的错误（守卫没被触发）', cons.length === 0, { errors: cons.slice(0, 5) });
    const assets = rec.responses.filter((r) => (sameOriginPath(r.url) ?? '').startsWith('/editor/assets/'));
    const badAssets = assets.filter((r) => r.status !== 200);
    report('S1 /editor/assets/ 的资源都取到了', assets.length > 0 && badAssets.length === 0, { assets: assets.length, bad: badAssets.slice(0, 5) });
    const text = (await bodyText(page)).trim();
    report('S1 页面有内容（开始页渲出来了）', text.length > 0, { text: text.slice(0, 120), pageErrors: rec.errors.slice(0, 3) });
    await page.close();
  }

  // S2 失效的邀请码
  {
    server.invite = { mode: 'invalid', name: '' };
    server.bodies.length = 0;
    const code = code43();
    const { page, rec } = await openPage();
    await page.goto(`${ORIGIN}/editor#invite=${code}`, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch((e) => rec.errors.push(`goto: ${e.message}`));
    const sent = await waitFor(() => server.bodies.some((b) => b.ep === 'resolve'), 5000);
    const resolve = server.bodies.find((b) => b.ep === 'resolve');
    report('S2 读到邀请码后向同源 resolve 提交', sent && resolve?.body?.code === code, { path: resolve?.path ?? null, bodyKeys: resolve?.body ? Object.keys(resolve.body) : null });
    const hash = await page.evaluate(() => location.hash);
    report('S2 # 片段已清掉（history.replaceState）', hash === '' || hash === '#', { hash });
    const noHash = (u) => { try { const x = new URL(u); x.hash = ''; return x.href; } catch { return u; } };
    const inUrls = [...rec.requests.map((r) => noHash(r.url)), ...server.log.map((l) => `${l.path}${l.search ?? ''}`)].filter((u) => u.includes(code));
    report('S2 邀请码不进任何地址（查询串、路径）', inUrls.length === 0, { urls: inUrls.slice(0, 5) });
    const stored = await page.evaluate((c) => {
      const dump = (s) => { const out = []; for (let i = 0; i < s.length; i++) { const k = s.key(i); out.push(`${k}=${s.getItem(k)}`); } return out.join('\n'); };
      return { local: dump(localStorage).includes(c), session: dump(sessionStorage).includes(c) };
    }, code);
    report('S2 邀请码不写 localStorage / sessionStorage', !stored.local && !stored.session, stored);
    const shown = await waitText(page, '这个邀请链接已失效', 5000);
    await page.screenshot({ path: path.join(OUT, 's2-invalid.png') });
    report('S2 失效提示用表 A 的文案', shown, { text: (await bodyText(page)).slice(0, 200) });
    report('S2 没有 /api/ 请求', shown && apiRequests(rec).length === 0, { api: apiRequests(rec).slice(0, 5) });
    await page.close();
  }

  // S3 有效的邀请码：显示项目名
  {
    const name = `探针项目-${randomBytes(2).toString('hex')}`;
    server.invite = { mode: 'valid', name };
    server.bodies.length = 0;
    const { page, rec } = await openPage();
    await page.goto(`${ORIGIN}/editor#invite=${code43()}`, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch((e) => rec.errors.push(`goto: ${e.message}`));
    const shown = await waitText(page, name, 6000);
    await page.screenshot({ path: path.join(OUT, 's3-valid.png') });
    report('S3 邀请码解析成功后显示项目名', shown, { name, text: (await bodyText(page)).slice(0, 200) });
    report('S3 解析不扣次数：只 resolve、没有 redeem', server.bodies.every((b) => b.ep === 'resolve'), { calls: server.bodies.map((b) => b.ep) });
    await page.close();
  }

  // S4 长度不对的码：不提交
  {
    server.invite = { mode: 'invalid', name: '' };
    server.bodies.length = 0;
    const { page, rec } = await openPage();
    await page.goto(`${ORIGIN}/editor#invite=${code43().slice(0, 20)}`, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch((e) => rec.errors.push(`goto: ${e.message}`));
    await sleep(3000);
    report('S4 长度不对的邀请码不提交', server.bodies.length === 0, { calls: server.bodies.length });
    await page.close();
  }

  // S5 深路由
  {
    const { page, rec } = await openPage();
    await page.goto(`${ORIGIN}/editor/some/deep/route`, { waitUntil: 'load', timeout: 30_000 }).catch((e) => rec.errors.push(`goto: ${e.message}`));
    await sleep(2000);
    await page.screenshot({ path: path.join(OUT, 's5-deep.png') });
    const text = (await bodyText(page)).trim();
    const bad = rec.responses.filter((r) => (sameOriginPath(r.url) ?? '').startsWith('/editor/assets/') && r.status !== 200);
    report('S5 深路由照常起来', text.length > 0 && bad.length === 0, { text: text.slice(0, 120), bad: bad.slice(0, 5), pageErrors: rec.errors.slice(0, 3) });
    report('S5 没有 /api/ 请求', text.length > 0 && apiRequests(rec).length === 0, { api: apiRequests(rec).slice(0, 5) });
    await page.close();
  }
} finally {
  await browser.close();
  httpServer.closeAllConnections?.();
  await new Promise((r) => httpServer.close(() => r()));
  if (tmpDist) fs.rmSync(tmpDist, { recursive: true, force: true });
}

const fails = results.filter((r) => !r.ok).map((r) => r.check);
console.log(JSON.stringify({ summary: { ok: fails.length === 0, checks: results.length, fails, shots: OUT } }));
process.exit(fails.length ? 1 : 0);
