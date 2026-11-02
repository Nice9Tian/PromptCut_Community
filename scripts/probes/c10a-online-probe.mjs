/**
 * Probe for C10a online page (`docs/plan/c10a-contract.md` section 2 "Online page makes no /api/* requests",
 * section 4 "Read invite code", section 12 "`/api` guard: no `/api/` requests in online build").
 * Written by the testing side; follows the contract only, ignoring implementation.
 *
 * Usage:
 *   node scripts/probes/c10a-online-probe.mjs [--dist <online-build-dir>] [--port 5650] [--out <shots-dir>] [--headful] [--force]
 *
 * - If `--dist` is omitted, runs `vite build --mode online` once itself, placing output in a temporary
 *   directory (without touching `dist-online/`).
 * - Probe starts a static server itself (default 127.0.0.1:5650, C10a testing port range 5650-5659),
 *   shaped after nginx in contract section 2:
 *   `/editor`, `/editor/index.html` return index.html (no-store); `/editor/assets/*` returns 404 if not
 *   found; all other `/editor/*` fall back to index.html.
 *   `/hosted/shared/invite/resolve|redeem` is mocked by the probe (returns invalid or project name
 *   depending on scenario) and records request bodies; all other `/hosted`, `/media`, and `/api`
 *   requests return 404 and are logged, and WebSocket upgrades are immediately closed. Never connects
 *   to any real hosted side.
 * - Browser opens in Chrome mobile emulation (390×844, touch screen, Android UA, injected
 *   `navigator.deviceMemory = 4`).
 * - Scenarios (one JSON line `{ check, ok, ... }` per item, final line `{ summary }`; exit code 1 on
 *   failure; exit code 2 when `src/online/mode.ts` is absent, `--force` runs anyway to check probe's
 *   own pipeline):
 *     S1 Open `/editor`: idle for 4 s; no same-origin `/api/` requests; no errors mentioning `/api/`
 *        in console; all `/editor/assets/` requests return 200.
 *     S2 Open `/editor#invite=<invalid-code>`: submits once to same-origin `…/shared/invite/resolve`
 *        within 5 s; code is in the request body, not in any URL; `#` fragment is cleared; code is not
 *        in localStorage / sessionStorage; Table A "This invite link has expired" appears on the page.
 *     S3 Open `/editor#invite=<valid-code>`: resolve returns project name; that project name appears
 *        on the page.
 *     S4 Open `/editor#invite=<wrong-length-code>`: does not send resolve within 3 s (character set and
 *        length verified first).
 *     S5 Open `/editor/some/deep/route`: page comes up normally (SPA fallback + `base: '/editor/'`),
 *        no same-origin `/api/` requests.
 *   Screenshots written to `--out` (default `out/c10a-online-probe`): `s1-start.png`, `s2-invalid.png`,
 *   `s3-valid.png`, `s5-deep.png`.
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
if (PORT < 5650 || PORT > 5659) console.error(`[c10a-online-probe] Note: port ${PORT} is not in the tester's port range 5650-5659`);
const OUT = path.resolve(ROOT, arg('out', 'out/c10a-online-probe'));
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const report = (check, ok, extra = {}) => { const r = { check, ok, ...extra }; results.push(r); console.log(JSON.stringify(r)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(path.join(ROOT, 'src', 'online', 'mode.ts')) && !flag('force')) {
  console.log(JSON.stringify({ summary: { ok: false, missing: 'Interface missing: src/online/mode.ts is absent (C10a online build not integrated); add --force to check only the probe pipeline' } }));
  process.exit(2);
}

// ------------------------------------------------------------------ Build

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
if (!fs.existsSync(INDEX)) { report('build', false, { error: `${INDEX} not found` }); process.exit(1); }

// ------------------------------------------------------------------ Static server + mock hosted side

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
    try { body = JSON.parse(text); } catch { /* Not JSON */ }
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

// ------------------------------------------------------------------ Browser

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
  // S1 Start page makes no /api/ requests
  {
    const { page, rec } = await openPage();
    await page.goto(`${ORIGIN}/editor`, { waitUntil: 'load', timeout: 30_000 }).catch((e) => rec.errors.push(`goto: ${e.message}`));
    await sleep(4000);
    await page.screenshot({ path: path.join(OUT, 's1-start.png') });
    const api = apiRequests(rec);
    const loaded = rec.responses.some((r) => (sameOriginPath(r.url) ?? '').startsWith('/editor/assets/') && r.status === 200);
    report('S1 the start page makes no /api/ requests', loaded && api.length === 0, { loaded, api: api.slice(0, 10) });
    const cons = apiConsole(rec);
    report('S1 no console errors mention /api/ (the guard was not triggered)', cons.length === 0, { errors: cons.slice(0, 5) });
    const assets = rec.responses.filter((r) => (sameOriginPath(r.url) ?? '').startsWith('/editor/assets/'));
    const badAssets = assets.filter((r) => r.status !== 200);
    report('S1 all resources under /editor/assets/ were fetched', assets.length > 0 && badAssets.length === 0, { assets: assets.length, bad: badAssets.slice(0, 5) });
    const text = (await bodyText(page)).trim();
    report('S1 the page has content (the start page rendered)', text.length > 0, { text: text.slice(0, 120), pageErrors: rec.errors.slice(0, 3) });
    await page.close();
  }

  // S2 Expired invite code
  {
    server.invite = { mode: 'invalid', name: '' };
    server.bodies.length = 0;
    const code = code43();
    const { page, rec } = await openPage();
    await page.goto(`${ORIGIN}/editor#invite=${code}`, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch((e) => rec.errors.push(`goto: ${e.message}`));
    const sent = await waitFor(() => server.bodies.some((b) => b.ep === 'resolve'), 5000);
    const resolve = server.bodies.find((b) => b.ep === 'resolve');
    report('S2 after reading the invite code, it submits to the same-origin resolve', sent && resolve?.body?.code === code, { path: resolve?.path ?? null, bodyKeys: resolve?.body ? Object.keys(resolve.body) : null });
    const hash = await page.evaluate(() => location.hash);
    report('S2 the # fragment was cleared (history.replaceState)', hash === '' || hash === '#', { hash });
    const noHash = (u) => { try { const x = new URL(u); x.hash = ''; return x.href; } catch { return u; } };
    const inUrls = [...rec.requests.map((r) => noHash(r.url)), ...server.log.map((l) => `${l.path}${l.search ?? ''}`)].filter((u) => u.includes(code));
    report('S2 the invite code does not appear in any URL (query string, path)', inUrls.length === 0, { urls: inUrls.slice(0, 5) });
    const stored = await page.evaluate((c) => {
      const dump = (s) => { const out = []; for (let i = 0; i < s.length; i++) { const k = s.key(i); out.push(`${k}=${s.getItem(k)}`); } return out.join('\n'); };
      return { local: dump(localStorage).includes(c), session: dump(sessionStorage).includes(c) };
    }, code);
    report('S2 the invite code is not written to localStorage / sessionStorage', !stored.local && !stored.session, stored);
    const shown = await waitText(page, 'This invite link is no longer valid', 5000);
    await page.screenshot({ path: path.join(OUT, 's2-invalid.png') });
    report('S2 the invalid-link message uses the wording of table A', shown, { text: (await bodyText(page)).slice(0, 200) });
    report('S2 no /api/ requests', shown && apiRequests(rec).length === 0, { api: apiRequests(rec).slice(0, 5) });
    await page.close();
  }

  // S3 Valid invite code: display project name
  {
    const name = `Probe project-${randomBytes(2).toString('hex')}`;
    server.invite = { mode: 'valid', name };
    server.bodies.length = 0;
    const { page, rec } = await openPage();
    await page.goto(`${ORIGIN}/editor#invite=${code43()}`, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch((e) => rec.errors.push(`goto: ${e.message}`));
    const shown = await waitText(page, name, 6000);
    await page.screenshot({ path: path.join(OUT, 's3-valid.png') });
    report('S3 the project name is shown after the invite code resolves successfully', shown, { name, text: (await bodyText(page)).slice(0, 200) });
    report('S3 resolving does not consume a use: only resolve, no redeem', server.bodies.every((b) => b.ep === 'resolve'), { calls: server.bodies.map((b) => b.ep) });
    await page.close();
  }

  // S4 Code with invalid length: do not submit
  {
    server.invite = { mode: 'invalid', name: '' };
    server.bodies.length = 0;
    const { page, rec } = await openPage();
    await page.goto(`${ORIGIN}/editor#invite=${code43().slice(0, 20)}`, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch((e) => rec.errors.push(`goto: ${e.message}`));
    await sleep(3000);
    report('S4 an invite code of the wrong length is not submitted', server.bodies.length === 0, { calls: server.bodies.length });
    await page.close();
  }

  // S5 Deep route
  {
    const { page, rec } = await openPage();
    await page.goto(`${ORIGIN}/editor/some/deep/route`, { waitUntil: 'load', timeout: 30_000 }).catch((e) => rec.errors.push(`goto: ${e.message}`));
    await sleep(2000);
    await page.screenshot({ path: path.join(OUT, 's5-deep.png') });
    const text = (await bodyText(page)).trim();
    const bad = rec.responses.filter((r) => (sameOriginPath(r.url) ?? '').startsWith('/editor/assets/') && r.status !== 200);
    report('S5 a deep route starts up normally', text.length > 0 && bad.length === 0, { text: text.slice(0, 120), bad: bad.slice(0, 5), pageErrors: rec.errors.slice(0, 3) });
    report('S5 no /api/ requests', text.length > 0 && apiRequests(rec).length === 0, { api: apiRequests(rec).slice(0, 5) });
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
