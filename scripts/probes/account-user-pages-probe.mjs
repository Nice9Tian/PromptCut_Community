// First import protects user directories and the shared port file before any fixture import.
import '../lib/no-user-dirs.mjs';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { editorSecurityHeaders, stageSecurityHeaders } from '../../src/online/stagePolicy.mjs';

/**
 * Real compiled online editor + frozen VisuHive site, two isolated editor users and
 * two fresh website sessions. No fetch/native/ready adapter is injected into pages.
 * Run only in the root-granted fixture window; this entry starts the G fixture and
 * two owned stage servers. It never builds, installs, uses the installed desktop,
 * or contacts production. Desktop native/IPC validation is a separate stage.
 *
 * node scripts/probes/account-user-pages-probe.mjs --dist <compiled dist-online>
 *   --site-root <held 016/site> --fixture-module <G fixed probe.mjs> --out <TMP directory>
 * Optional actual desktop: --desktop-exe <isolated account-probe.exe>
 *   --desktop-profile-root <TMP child>. Root owns the prestarted Vite 6340/41/42.
 *
 * Dependencies: G startAccountDualUserFixture({publicHandler}), true account/doc/asset
 * TLS gateway 6388 and owned internal ports; stage policy origins 6341/6342.
 * Account credentials remain in RAM. Only phase/status/project identifiers and
 * safe network metadata are saved. Screenshots never contain entered passwords.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const arg = key => { const i = argv.indexOf(key); return i < 0 ? undefined : argv[i + 1]; };
const required = key => { const value = arg(key); if (!value || value.startsWith('--')) throw new Error(`missing-${key.slice(2)}`); return path.resolve(value); };
const DIST = required('--dist');
const SITE = required('--site-root');
const FIXTURE = path.resolve(arg('--fixture-module') ?? path.join(ROOT, 'cloud/scripts/probes/account-dual-user-path-probe.mjs'));
const OUT = path.resolve(arg('--out') ?? path.join(os.tmpdir(), `pc-account-user-pages-${randomUUID()}`));
const tmpRelative = path.relative(os.tmpdir(), OUT);
if (!tmpRelative || tmpRelative.startsWith('..') || path.isAbsolute(tmpRelative)) throw new Error('output-must-be-private-tmp-child');
const DESKTOP_EXE = arg('--desktop-exe') ? path.resolve(arg('--desktop-exe')) : null;
const DESKTOP_PROFILE = DESKTOP_EXE ? required('--desktop-profile-root') : null;
if (DESKTOP_EXE) {
  const relative = path.relative(os.tmpdir(), DESKTOP_EXE);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || path.extname(DESKTOP_EXE).toLowerCase() !== '.exe') throw new Error('desktop-exe-must-be-isolated-tmp-build');
}
if (DESKTOP_PROFILE) {
  const relative = path.relative(os.tmpdir(), DESKTOP_PROFILE);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('desktop-profile-must-be-private-tmp-child');
}
const DESKTOP_ORIGIN = 'http://127.0.0.1:6340';
const ORIGIN = 'https://127.0.0.1:6388';
const STAGES = ['http://s1.pc.localhost:6341', 'http://s2.pc.localhost:6342'];
const TIMEOUT = 60_000; // A missing product result is a failure; no automatic retry.
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.woff':'font/woff', '.woff2':'font/woff2', '.ttf':'font/ttf', '.wasm':'application/wasm' };
const source = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, windowsHide: true, encoding: 'utf8' }).trim();
const result = { sourceBefore: source(), checks: [], screenshots: [], network: [], resources: [], websocket: [], stageDocuments:[], phase: 'preflight', desktop: 'not-run', cleanup: {} };
let fixture, browser;
let native, nativeAttempt = 0;
const stages = [], contexts = [], pages = [], responseTasks = new Set(), networkObservers = [];
let browserPid;
function assert(ok, name) { result.checks.push({ check: name, ok: Boolean(ok) }); if (!ok) { const error = new Error(name); error.probeCheck = name; throw error; } }
async function getChromePath() { const executable = await puppeteer.executablePath(); await fs.access(executable); return executable; }
function below(root, relative) { const target = path.resolve(root, relative); const rel = path.relative(root, target); return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? target : null; }
async function sendFile(req, res, root, relative, headers) {
  const file = below(root, relative);
  let stat;
  try { stat = file && await fs.stat(file); } catch { /* genuine static 404 */ }
  if (!stat?.isFile()) { res.writeHead(404, headers); res.end(); return; }
  const bytes = await fs.readFile(file);
  res.writeHead(200, { ...headers, 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'content-length': bytes.length, 'cache-control':'no-store' });
  res.end(req.method === 'HEAD' ? undefined : bytes);
}
function staticHandler(stage = false) {
  return async (req, res) => {
    const headers = stage ? stageSecurityHeaders(ORIGIN) : editorSecurityHeaders(STAGES);
    const url = new URL(req.url, ORIGIN);
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, headers); res.end(); return; }
    if (url.pathname === '/editor/runtime-config.json') {
      const body = JSON.stringify({ v: 1, stageOrigins: STAGES });
      res.writeHead(200, { ...headers, 'content-type':'application/json', 'cache-control':'no-store' }); res.end(body); return;
    }
    if (url.pathname === '/editor/_iso/ok') { res.writeHead(204, headers); res.end(); return; }
    if (url.pathname === '/editor/_iso/redirect') { res.writeHead(302, { ...headers, location:'/editor/_iso/ok' }); res.end(); return; }
    if (url.pathname === '/editor' || url.pathname === '/editor/' || url.pathname === '/editor/index.html') return sendFile(req, res, DIST, 'index.html', headers);
    if (url.pathname.startsWith('/editor/')) return sendFile(req, res, DIST, decodeURIComponent(url.pathname.slice('/editor/'.length)), headers);
    if (url.pathname.startsWith('/catalog/')) return sendFile(req, res, DIST, decodeURIComponent(url.pathname.slice(1)), headers);
    if (!stage) {
      const file = url.pathname === '/' ? 'index.html' : ['/account','/login','/register','/reset'].includes(url.pathname) ? `${url.pathname.slice(1)}.html` : decodeURIComponent(url.pathname.slice(1));
      return sendFile(req, res, SITE, file, { 'referrer-policy':'no-referrer', 'x-content-type-options':'nosniff' });
    }
    res.writeHead(404, headers); res.end();
  };
}
async function startStage(port) {
  const sockets = new Set();
  const handler = staticHandler(true);
  const server = http.createServer((req, res) => {
    if (new URL(req.url, ORIGIN).pathname === '/editor/stage.html') result.stageDocuments.push({ port, method:req.method });
    void handler(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  const owned = { server, sockets, port }; stages.push(owned);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
}
async function newPage(context, label) {
  const page = await context.newPage(); return observePage(page, label);
}
async function observePage(page, label) {
  pages.push(page);
  page.setDefaultTimeout(TIMEOUT); page.setDefaultNavigationTimeout(TIMEOUT);
  page.safeResponses = { projects: null, create: null, join: null };
  page.on('pageerror', error => { result.network.push({ page: label, kind:'pageerror', name: error.name }); });
  const resourcePath = request => {
    const url = new URL(request.url());
    if (![ORIGIN, ...STAGES].includes(url.origin) || !['document', 'stylesheet', 'script', 'font', 'image'].includes(request.resourceType())) return null;
    return url.pathname.startsWith('/editor/') || url.pathname.startsWith('/assets/') ? url.pathname : null;
  };
  page.on('requestfailed', request => {
    const pathname = resourcePath(request);
    if (!pathname) return;
    const error = request.failure()?.errorText;
    result.resources.push({ page:label, kind:'requestfailed', path:pathname, type:request.resourceType(),
      name:typeof error === 'string' && /^net::ERR_[A-Z0-9_]+$/.test(error) ? error : 'request-failed' });
  });
  page.on('response', response => {
    const pathname = resourcePath(response.request());
    if (pathname) {
      const mime = response.headers()['content-type'];
      result.resources.push({ page:label, kind:'response', path:pathname, type:response.request().resourceType(), status:response.status(),
        mime:typeof mime === 'string' && /^[a-z0-9.+-]+\/[a-z0-9.+-]+(?:;\s*charset=[a-z0-9_-]+)?$/i.test(mime) ? mime : mime === undefined ? 'missing' : 'unexpected-content-type' });
    }
    const url = new URL(response.url());
    if (![ORIGIN, ...STAGES].includes(url.origin)) return;
    if (!url.pathname.startsWith('/api/account') && !url.pathname.startsWith('/hosted/')) return;
    result.network.push({ page: label, method: response.request().method(), path: url.pathname, status: response.status() });
    const key = url.pathname === '/api/account/projects' ? 'projects' : url.pathname === '/hosted/shared/account/create' ? 'create' : url.pathname === '/hosted/shared/account/join' ? 'join' : null;
    if (!key || !response.ok()) return;
    const task = response.json().then(body => {
      // Discard all ticket, account, cookie, CSRF and credential fields immediately.
      page.safeResponses[key] = key === 'projects' ? {
        owned: (body.owned ?? []).map(p => ({ projectId:p.projectId, name:p.name })),
        joined: (body.joined ?? []).map(p => ({ projectId:p.projectId, name:p.name })),
      } : { projectId: body.projectId ?? body.membership?.projectId };
    }).catch(() => {}).finally(() => responseTasks.delete(task));
    responseTasks.add(task);
  });
  // CDP observes the real handshake and bytes without replacing WebSocket or
  // reading its credential-bearing URL/query, headers, protocols or full frames.
  const cdp = await page.createCDPSession(); networkObservers.push(cdp);
  const sockets = new Map();
  cdp.on('Network.webSocketCreated', ({ requestId, url }) => {
    let parsed;
    try { parsed = new URL(url); } catch { return; }
    if (parsed.origin !== ORIGIN.replace(/^https:/, 'wss:') || parsed.pathname !== '/hosted/') return;
    sockets.set(requestId, { path: parsed.pathname });
    result.websocket.push({ page: label, kind: 'created', path: parsed.pathname });
  });
  const record = (requestId, entry) => {
    const socket = sockets.get(requestId);
    if (socket) result.websocket.push({ page: label, path: socket.path, ...entry });
  };
  cdp.on('Network.webSocketHandshakeResponseReceived', ({ requestId, response }) => {
    record(requestId, { kind: 'handshake', status: response.status });
  });
  const frame = (direction, { requestId, response }) => {
    if (!sockets.has(requestId)) return;
    if (response.opcode === 8) {
      // CDP binary payloads are base64. Retain only the two-byte close code;
      // never retain the close reason or the payload itself.
      const bytes = Buffer.from(response.payloadData, 'base64');
      record(requestId, { kind: 'close-frame', direction, code: bytes.length >= 2 ? bytes.readUInt16BE(0) : null });
      return;
    }
    if (response.opcode !== 1) return;
    let type;
    try { type = JSON.parse(response.payloadData).type; } catch { return; }
    if (typeof type === 'string' && /^[a-zA-Z][a-zA-Z0-9_.:-]{0,99}$/.test(type)) record(requestId, { kind: 'message', direction, type });
  };
  cdp.on('Network.webSocketFrameReceived', event => frame('received', event));
  cdp.on('Network.webSocketFrameSent', event => frame('sent', event));
  cdp.on('Network.webSocketFrameError', ({ requestId }) => record(requestId, { kind: 'frame-error' }));
  cdp.on('Network.webSocketClosed', ({ requestId }) => { record(requestId, { kind: 'closed' }); sockets.delete(requestId); });
  await cdp.send('Network.enable');
  return page;
}
async function type(page, selector, value) {
  const input = await page.waitForSelector(selector, { visible:true });
  await input.focus();
  await page.keyboard.down('Control');
  try { await page.keyboard.press('A'); } finally { await page.keyboard.up('Control'); }
  await page.keyboard.press('Backspace'); await input.type(value);
}
async function safeShot(page, label) {
  for (const input of await page.$$('input[type="password"]')) {
    const visible = await input.evaluate(el => el.getClientRects().length > 0);
    if (visible) { await input.click({ clickCount:3 }); await page.keyboard.press('Backspace'); }
  }
  const safe = await page.$$eval('input[type="password"]', nodes => nodes.every(el => !el.getClientRects().length || el.value === ''));
  if (!safe) throw new Error('password-screenshot-blocked');
  const name = `${label}.png`; await page.screenshot({ path:path.join(OUT, name), fullPage:true }); result.screenshots.push(name);
}
async function loginEditor(page, account) {
  const parentPhase = result.phase;
  const step = async (stage, action) => {
    result.loginStage = stage; result.loginSteps ??= [];
    result.loginSteps.push({ phase:parentPhase, stage, state:'started', ui:await loginUiState(page) });
    try {
      await action();
      result.loginSteps.push({ phase:parentPhase, stage, state:'completed', ui:await loginUiState(page) });
    } catch (error) {
      result.loginSteps.push({ phase:parentPhase, stage, state:'failed', ui:await loginUiState(page) });
      throw error;
    }
  };
  await step('goto', () => page.goto(DESKTOP_EXE && page === native?.page ? `${DESKTOP_ORIGIN}/` : `${ORIGIN}/editor/`, { waitUntil:'domcontentloaded' }));
  await step('username-input', () => type(page, '[data-pc="account-projects"] input[name="username"]', account.name));
  await step('password-input', () => type(page, '[data-pc="account-projects"] input[name="password"]', account.password));
  await step('submit', async () => {
    await page.waitForFunction(() => {
      const button = document.querySelector('[data-pc="account-projects"] form button.sp-primary-btn');
      return Boolean(button && !button.disabled);
    });
    result.loginSteps.push({ phase:parentPhase, stage:'submit-ready', state:'completed', ui:await loginUiState(page) });
    await page.click('[data-pc="account-projects"] form button.sp-primary-btn');
  });
  await step('account-name', async () => {
    await page.waitForSelector('[data-pc="account-name"]', { visible:true });
    assert((await page.$eval('[data-pc="account-name"]', el => el.textContent)).includes(account.name), 'editor-authenticated-account');
  });
}
async function loginUiState(page) {
  return page.evaluate(() => {
    const visible = selector => Boolean(document.querySelector(selector)?.getClientRects().length);
    const button = document.querySelector('[data-pc="account-projects"] form button.sp-primary-btn');
    const error = document.querySelector('[data-pc="account-error"]');
    // Exact known product messages map to fixed codes; unknown DOM text is never
    // copied. No input value, account-name text or credential is inspected here.
    const known = new Map([
      ['请先登录账号。', 'login-required'], ['登录已失效，请重新登录。', 'credential-revoked'],
      ['账号或密码不正确。', 'bad-login'], ['这个项目名已被使用，请换一个名字。', 'name-taken'],
      ['你已被禁止加入这个项目。', 'banned'], ['你不在这个项目的成员名单中。', 'not-listed'],
      ['这个云端项目已不存在。', 'project-gone'], ['素材服务暂时不可用，项目尚不能进入，请稍后重试。', 'asset-unavailable'],
      ['项目会话暂时不可用，请稍后重试。', 'session-unavailable'], ['请使用桌面版登录，或在官网打开在线编辑器。', 'desktop-bridge-unavailable'],
      ['暂时无法获取云端项目列表，请稍后重试。', 'projects-unavailable'], ['云端服务暂时不可用，请稍后重试。', 'service-unavailable'],
      ['没有访问这个项目的权限。', 'forbidden'], ['连接云端失败，请检查网络后重试。', 'network'],
      ['无法取得当前设备身份，请重试。', 'device-unavailable'], ['登录恢复失败，请重新登录。', 'restore-failed'],
      ['账号入口初始化失败。', 'initialization-failed'], ['请求失败，请重试。', 'request-failed'],
    ]);
    const buttonText = button?.textContent?.trim();
    return { accountForm:visible('[data-pc="account-projects"]'), usernameVisible:visible('[data-pc="account-projects"] input[name="username"]'),
      passwordVisible:visible('[data-pc="account-projects"] input[name="password"]'), accountNameVisible:visible('[data-pc="account-name"]'),
      editorVisible:visible('[data-pc="editor"]'), submitVisible:Boolean(button?.getClientRects().length), submitDisabled:Boolean(button?.disabled),
      busy:buttonText === '正在连接…' ? 'connecting' : buttonText === '正在处理…' ? 'processing' : buttonText === '登录账号' ? 'idle' : 'unknown',
      errorVisible:Boolean(error?.getClientRects().length), errorCode:error ? known.get(error.textContent?.trim()) ?? 'other-error' : 'none',
      tauriInvoke:typeof window.__TAURI__?.core?.invoke === 'function' };
  }).catch(() => ({ state:'ui-unavailable' }));
}
async function waitEditor(page, check) {
  await page.waitForSelector('[data-pc="editor"]', { visible:true });
  await page.waitForSelector('[data-pc="cloud-project-copy"]', { visible:true });
  assert(!(await page.$('[data-pc="account-projects"]')), check);
}
async function copyState(page) {
  // Read only fixed classifications, never clipboard contents or complete DOM text.
  return page.evaluate(async () => {
    const button = document.querySelector('[data-pc="cloud-project-copy"]');
    const toast = document.querySelector('[data-pc="sync-toasts"]')?.textContent ?? '';
    let permission = 'unavailable';
    try {
      permission = await Promise.race([
        navigator.permissions.query({ name:'clipboard-write' }).then(value => ['granted', 'denied', 'prompt'].includes(value.state) ? value.state : 'unknown'),
        new Promise(resolve => setTimeout(() => resolve('query-timeout'), 1000)),
      ]);
    } catch { /* Unsupported browser permission query. */ }
    return { buttonPresent:Boolean(button), buttonVisible:Boolean(button?.getClientRects().length),
      buttonDisabled:Boolean(button?.disabled), buttonFocused:document.activeElement === button, documentFocused:document.hasFocus(),
      clipboardApi:typeof navigator.clipboard?.writeText === 'function', permission,
      enteredToast:toast.includes('已进入云端项目'), copiedToast:toast.includes('项目链接已复制。'),
      fallbackToast:/项目链接：https:\/\/127\.0\.0\.1:6388\/editor(?:\?project=|\/[ps]\/)/.test(toast) };
  }).catch(() => ({ state:'copy-diagnostic-unavailable' }));
}
async function websiteList(account, kind, projectId, name, label) {
  const context = await browser.createBrowserContext(); contexts.push(context);
  const page = await newPage(context, label);
  await page.goto(`${ORIGIN}/login`, { waitUntil:'domcontentloaded' });
  await type(page, '#login input[name="name"]', account.name);
  await type(page, '#login input[name="password"]', account.password);
  await Promise.all([page.waitForNavigation({ waitUntil:'domcontentloaded' }), page.click('#login button[type="submit"]')]);
  assert(new URL(page.url()).pathname === '/account', `${label}-website-login`);
  await page.waitForFunction((kind, name) => [...document.querySelectorAll(`#${kind} li`)].some(el => el.textContent === name), {}, kind, name);
  await Promise.all([...responseTasks]);
  assert(page.safeResponses.projects?.[kind]?.some(p => p.projectId === projectId && p.name === name), `${label}-authoritative-${kind}-id-name`);
  assert((await page.$eval('#acc-name', el => el.textContent)) === account.name, `${label}-website-account`);
  await safeShot(page, label);
  // A website login must restore in the online editor through the shared cookie.
  const restored = await newPage(context, `${label}-restored-editor`);
  await restored.goto(`${ORIGIN}/editor/?ui=classic`, { waitUntil:'domcontentloaded' });
  await restored.waitForSelector('[data-pc="account-name"]', { visible:true });
  assert(!(await restored.$('[data-pc="account-projects"] input[name="password"]')), `${label}-cookie-restores-editor-without-password`);
  await safeShot(restored, `${label}-cookie-restore`);
}

async function waitFor(check, name, timeout = TIMEOUT) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 200)); }
  const error = new Error(name); error.probeCheck = name; throw error;
}
function childClosed(child) {
  return child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((resolve, reject) => {
    child.once('close', resolve); child.once('error', reject);
  });
}
function nativeDescendants(pid) {
  // Only public PID/parent metadata: never query process command lines or secrets.
  const text = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'],
  { windowsHide:true, encoding:'utf8', timeout:15_000 });
  const rows = JSON.parse(text), ids = new Set([pid]);
  for (let changed = true; changed;) { changed = false; for (const row of rows) if (ids.has(row.ParentProcessId) && !ids.has(row.ProcessId)) { ids.add(row.ProcessId); changed = true; } }
  return [...ids];
}
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } }
async function cdpClosed() {
  return new Promise(resolve => {
    const socket = net.connect({ host:'127.0.0.1', port:6348 });
    let closed = false;
    socket.once('connect', () => socket.destroy());
    socket.once('error', error => { closed = error.code === 'ECONNREFUSED'; });
    socket.setTimeout(1000, () => socket.destroy());
    socket.once('close', () => resolve(closed));
  });
}
function nativeCertificatePin(fingerprint) {
  if (typeof fingerprint !== 'string' || !/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(fingerprint)) throw new Error('invalid-native-certificate-pin');
  return fingerprint.replaceAll(':', '').toLowerCase();
}
async function startNative(label) {
  await fs.access(DESKTOP_EXE);
  assert(await cdpClosed(), 'native-cdp-is-not-another-process');
  await fs.mkdir(DESKTOP_PROFILE, { recursive:true });
  const env = { ...process.env, USERPROFILE:DESKTOP_PROFILE,
    PROMPTCUT_ACCOUNT_TEST_EDITOR_PORT:'6340', PROMPTCUT_ACCOUNT_TEST_CLOUD_ORIGIN:ORIGIN,
    PROMPTCUT_ACCOUNT_TEST_CLOUD_PIN:nativeCertificatePin(fixture.leafFingerprint256), PROMPTCUT_AGENT_CDP:'6348',
    WEBVIEW2_USER_DATA_FOLDER:path.join(DESKTOP_PROFILE, 'webview2'), PROMPTCUT_NO_PORT_FILE:'1' };
  const child = spawn(DESKTOP_EXE, [], { cwd:path.dirname(DESKTOP_EXE), env, windowsHide:true, stdio:['ignore', 'ignore', 'pipe'] });
  const state = { child, env, connection:null, page:null, closed:childClosed(child) }; native = state;
  const attempt = ++nativeAttempt, limit = 16 * 1024;
  let capturing = true, bytes = 0, truncated = false, chunks = [], ipcConfirmed = false;
  child.stderr.on('data', chunk => {
    // Keep draining for the process lifetime, but retain only pre-IPC startup
    // stderr, bounded in bytes. No login operation has happened at this stage.
    if (!capturing) return;
    const remaining = limit - bytes, retained = Math.min(chunk.length, remaining);
    if (retained) { chunks.push(Buffer.from(chunk.subarray(0, retained))); bytes += retained; }
    if (chunk.length > retained) truncated = true;
  });
  // Supervise immediately; propagate startup failure through the normal first error.
  state.closed.catch(() => {});
  try {
  await waitFor(async () => {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('native-exited-before-cdp');
    try { state.connection = await puppeteer.connect({ browserURL:'http://127.0.0.1:6348', defaultViewport:null, protocolTimeout:TIMEOUT }); return true; }
    catch { return false; }
  }, 'native-cdp-start');
  await waitFor(async () => {
    state.page = (await state.connection.pages()).find(page => page.url().startsWith(`${DESKTOP_ORIGIN}/`)); return Boolean(state.page);
  }, 'native-main-target');
  await observePage(state.page, label);
  await state.page.waitForFunction(() => Boolean(window.__TAURI__?.core?.invoke));
  const session = await state.page.createCDPSession();
  await session.send('Security.setIgnoreCertificateErrors', { ignore:true });
  await state.connection.defaultBrowserContext().overridePermissions(DESKTOP_ORIGIN, []);
  const bridge = await state.page.evaluate(async () => {
    const tauri = window.__TAURI__;
    if (!tauri?.core?.invoke) return null;
    const info = await tauri.core.invoke('agent_webview_info');
    const config = await tauri.core.invoke('account_bridge', { operation:'configuration', args:{} });
    return { main:tauri.webview.getCurrentWebview().label === 'main', window:tauri.window.getCurrentWindow().label === 'main',
      agentReady:info.ready === true, port:info.port, origin:config.origin, ok:config.ok === true };
  });
  assert(bridge?.main && bridge.window && bridge.agentReady && bridge.port === 6348 && bridge.ok && bridge.origin === ORIGIN, 'actual-main-and-agent-configuration-ipc');
  ipcConfirmed = true;
  } finally {
    capturing = false;
    const raw = Buffer.concat(chunks, bytes); chunks = [];
    const text = raw.toString('utf8'), osCode = text.match(/os error ([0-9]{1,10})/i)?.[1];
    const classification = /failed to build tauri application/.test(text) ? 'tauri-build-panic' :
      /failed to resolve app data dir/.test(text) ? 'app-data-dir-panic' :
      /failed to resolve app log dir/.test(text) ? 'app-log-dir-panic' :
      /failed to resolve resource dir/.test(text) ? 'resource-dir-panic' :
      /thread .* panicked at/.test(text) ? 'rust-panic' : /webview2/i.test(text) ? 'webview2-startup' :
      bytes ? 'unclassified-startup-stderr' : 'no-startup-stderr';
    const file = `native-startup-${attempt}.stderr.log`;
    let saved = false;
    try { await fs.writeFile(path.join(OUT, file), raw, { flag:'wx', mode:0o600 }); saved = true; }
    catch { result.cleanup.nativeStartupWriteFailed = true; process.exitCode = 1; }
    result.nativeStartup ??= [];
    result.nativeStartup.push({ attempt, pid:child.pid, ipcConfirmed, exitCode:child.exitCode,
      signal:child.signalCode, classification, ...(osCode ? { osErrorCode:Number(osCode) } : {}),
      capturedBytes:bytes, truncated, file:saved ? file : null });
    // Raw stderr is TMP-only. It is never printed or copied into result.json/Git.
  }
  let agent;
  await waitFor(async () => { agent = (await state.connection.pages()).find(page => page !== state.page && page.url().startsWith('about:blank')); return Boolean(agent); }, 'actual-agent-target');
  // Navigate only this owned agent webview to the allowed main origin to prove
  // that same URL/window cannot substitute for the invoking webview label.
  await agent.goto(`${DESKTOP_ORIGIN}/`, { waitUntil:'domcontentloaded' });
  const denied = await agent.evaluate(async () => {
    if (!window.__TAURI__?.core?.invoke) return { invoked:false };
    try { await window.__TAURI__.core.invoke('account_bridge', { operation:'configuration', args:{} }); return { invoked:true, denied:false }; }
    catch { return { invoked:true, denied:true, agent:window.__TAURI__.webview.getCurrentWebview().label === 'agent' }; }
  });
  assert(denied.invoked && denied.denied && denied.agent, 'actual-agent-account-bridge-denied');
  result.desktop = 'actual-shell-in-progress';
  result.nativePids ??= []; result.nativePids.push(child.pid);
  return state.page;
}
async function quitNative() {
  if (!native) return;
  const state = native, ownedPids = nativeDescendants(state.child.pid);
  const quit = spawn(DESKTOP_EXE, ['--quit'], { cwd:path.dirname(DESKTOP_EXE), env:state.env, windowsHide:true, stdio:'ignore' });
  await childClosed(quit);
  assert(quit.exitCode === 0, 'actual-native-quit-command');
  await Promise.race([state.closed, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('native-actual-close-timeout')), TIMEOUT); timer.unref(); })]);
  state.connection?.disconnect();
  await waitFor(() => Promise.resolve(ownedPids.every(pid => !pidAlive(pid))), 'native-owned-process-tree-closed');
  await waitFor(cdpClosed, 'native-cdp-listener-closed');
  result.cleanup.nativeRuns ??= []; result.cleanup.nativeRuns.push({ pid:state.child.pid, ownedPids, exitCode:state.child.exitCode, actualClosed:true, cdpClosed:true });
  native = null;
}

await fs.mkdir(OUT, { recursive:true });
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-account-user-pages-chrome-'));
const wallStart = Date.now();
try {
  for (const file of [path.join(DIST, 'index.html'), path.join(DIST, 'stage.html'), path.join(SITE, 'account.html'), path.join(SITE, 'login.html'), FIXTURE]) await fs.access(file);
  const { startAccountDualUserFixture } = await import(pathToFileURL(FIXTURE).href);
  assert(typeof startAccountDualUserFixture === 'function', 'true-fixture-export');
  fixture = await startAccountDualUserFixture({ publicHandler: staticHandler() });
  assert(fixture.origin === ORIGIN && fixture.accounts?.length === 2, 'true-fixture-origin-and-two-accounts');
  result.fixture = { origin:fixture.origin, ports:fixture.ports, assetPid:fixture.assetPid };
  if (!DESKTOP_EXE) { await startStage(6341); await startStage(6342); }
  browser = await puppeteer.launch({ executablePath:await getChromePath(), headless:true, pipe:true, acceptInsecureCerts:true, userDataDir:profile,
    defaultViewport:{ width:1440, height:1000 }, protocolTimeout:TIMEOUT,
    args:[...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--no-default-browser-check', '--force-device-scale-factor=1', '--mute-audio'] });
  browserPid = browser.process()?.pid; result.browserPid = browserPid;
  let a, b;
  if (DESKTOP_EXE) { result.phase = 'native-start'; a = await startNative('desktop-a'); }
  else {
    const [ctxA, ctxB] = await Promise.all([browser.createBrowserContext(), browser.createBrowserContext()]); contexts.push(ctxA, ctxB);
    // Normal browser clipboard denial makes the product's visible link fallback
    // available without changing the user's OS clipboard or injecting JS mocks.
    await ctxA.overridePermissions(ORIGIN, []); await ctxB.overridePermissions(ORIGIN, []);
    a = await newPage(ctxA, 'editor-a'); b = await newPage(ctxB, 'editor-b');
  }
  result.phase = 'editor-a-login'; await loginEditor(a, fixture.accounts[0]); await safeShot(a, '01-editor-a-logged-in');
  result.phase = 'editor-a-create'; const name = `双账号页面验收-${randomUUID().slice(0, 8)}`; result.projectName = name;
  await type(a, '[data-pc="cloud-project-name"]', name); await a.click('[data-pc="cloud-create"]'); await waitEditor(a, 'creator-enters-real-editor');
  result.copy = { before:await copyState(a) };
  try {
    await a.click('[data-pc="cloud-project-copy"]');
    // 2026-10-23 起生成的链接是 `/editor/p/…`、`/editor/s/…`,旧形式 `?project=` 也认
    await a.waitForFunction(() => /项目链接：https:\/\/127\.0\.0\.1:6388\/editor(?:\?project=|\/[ps]\/)/.test(document.querySelector('[data-pc="sync-toasts"]')?.textContent ?? ''));
  } finally { result.copy.after = await copyState(a); }
  const link = await a.$eval('[data-pc="sync-toasts"]', el => el.textContent.match(/https:\/\/127\.0\.0\.1:6388\/editor\?project=sp_[a-z2-7]{26}/)?.[0]);
  assert(Boolean(link), 'visible-project-link-after-start-page-unmount');
  const projectId = new URL(link).searchParams.get('project'); result.projectId = projectId;
  assert(projectId !== fixture.projectId, 'created-through-page-not-fixture-baseline');
  await safeShot(a, '02-editor-a-created-visible-link');
  if (DESKTOP_EXE) {
    result.phase = 'native-quit-and-recover'; await quitNative();
    a = await startNative('desktop-a-recovered');
    await a.waitForSelector('[data-pc="account-name"]', { visible:true });
    assert((await a.$eval('[data-pc="account-name"]', el => el.textContent)).includes(fixture.accounts[0].name), 'actual-dpapi-recovery-after-shell-restart');
    assert(!(await a.$('[data-pc="account-projects"] input[name="password"]')), 'native-recovered-without-password');
    await safeShot(a, 'desktop-a-dpapi-recovered');
    result.phase = 'native-account-switch';
    await a.goto(`${DESKTOP_ORIGIN}/`, { waitUntil:'domcontentloaded' });
    await a.waitForSelector('[data-pc="account-name"]', { visible:true });
    // Locate the actual visible logout control; no direct native logout shortcut.
    const buttons = await a.$$('[data-pc="account-projects"] button');
    let logoutButton;
    for (const button of buttons) if (await button.evaluate(el => el.textContent?.trim() === '退出登录')) logoutButton = button;
    assert(Boolean(logoutButton), 'actual-desktop-logout-control'); await logoutButton.click();
    await a.waitForSelector('[data-pc="account-projects"] input[name="password"]', { visible:true });
    assert(!(await a.$('[data-pc="account-name"]')), 'actual-native-logout-visible-success');
    b = a;
  } else {
    await a.waitForFunction(origins => origins.every(origin => [...document.querySelectorAll('iframe')].some(frame => {
      try { return new URL(frame.src).origin === origin; } catch { return false; }
    })), {}, STAGES);
    // DOM insertion can precede the second stage's actual HTTP request.
    await waitFor(() => STAGES.every((_, i) => result.stageDocuments.some(request => request.port === 6341 + i && request.method === 'GET')), 'both-compiled-stage-policy-origins-used');
    assert(STAGES.every((_, i) => result.stageDocuments.some(request => request.port === 6341 + i)), 'both-compiled-stage-policy-origins-used');
  }
  result.phase = 'editor-b-login'; await loginEditor(b, fixture.accounts[1]);
  result.phase = 'editor-b-join'; await type(b, '[data-pc="cloud-project-link"]', link); await b.click('[data-pc="cloud-join"]'); await waitEditor(b, 'member-enters-real-editor');
  await safeShot(b, '03-editor-b-joined');
  result.phase = 'website-a'; await websiteList(fixture.accounts[0], 'owned', projectId, name, '04-website-a-owned');
  result.phase = 'website-b'; await websiteList(fixture.accounts[1], 'joined', projectId, name, '05-website-b-joined');
  if (DESKTOP_EXE) { await quitNative(); result.desktop = 'actual-shell-path-complete'; }
  else {
    assert(result.network.some(r => r.path === '/hosted/shared/account/create' && r.status === 201), 'real-create-201');
    assert(result.network.some(r => r.path === '/hosted/shared/account/join' && r.status === 200), 'real-join-200');
  }
  result.phase = 'complete';
} catch (error) {
  result.failure = { phase:result.phase, name:error?.name ?? 'Error', check:error?.probeCheck ?? null };
  // Error messages/bodies may include credentials; only controlled check names
  // and phase are recorded. Preserve the first failure without retrying it.
  process.exitCode = 1;
  result.screenshotAttempts ??= [];
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i], label = `failure-${i + 1}`;
    if (page.isClosed()) { result.screenshotAttempts.push({ label, state:'page-closed' }); continue; }
    try { await safeShot(page, label); result.screenshotAttempts.push({ label, state:'saved' }); }
    catch (error) { result.screenshotAttempts.push({ label, state:error?.message === 'password-screenshot-blocked' ? 'password-not-cleared' : 'capture-failed' }); }
  }
} finally {
  await Promise.allSettled([...responseTasks]);
  if (native) {
    try { await quitNative(); }
    catch { result.cleanup.nativeFailed = true; native.connection?.disconnect(); process.exitCode = 1; }
  }
  for (const observer of networkObservers) await observer.detach().catch(() => {});
  for (const context of contexts) await context.close().catch(() => {});
  if (browser) {
    const child = browser.process();
    const closed = child && child.exitCode === null ? new Promise(resolve => child.once('close', resolve)) : Promise.resolve();
    try { await browser.close(); await closed; }
    catch { result.cleanup.browserCloseFailed = true; }
    result.cleanup.browserClosed = !child || child.exitCode !== null || child.signalCode !== null;
  }
  for (const owned of stages) {
    const closed = owned.server.listening ? new Promise((resolve, reject) => owned.server.close(error => error ? reject(error) : resolve())) : Promise.resolve();
    const socketCloses = [...owned.sockets].map(socket => new Promise(resolve => { if (socket.closed) resolve(); else { socket.once('close', resolve); socket.destroy(); } }));
    await Promise.all([closed, ...socketCloses]);
  }
  result.cleanup.stages = stages.map(s => ({ port:s.port, listening:s.server.listening, sockets:s.sockets.size }));
  if (fixture) {
    try { const state = await fixture.close(); result.cleanup.fixture = { closed:state?.closed === true, childClosed:state?.childClosed === true }; }
    catch { result.cleanup.fixture = { closed:false, childClosed:false }; }
  }
  if (result.cleanup.browserClosed) await fs.rm(profile, { recursive:true, force:true });
  result.cleanup.profileRemoved = !fsSync.existsSync(profile);
  result.sourceAfter = source(); result.wallMs = Date.now() - wallStart;
  result.summary = { checks:result.checks.length, passed:result.checks.filter(c => c.ok).length, failed:result.checks.filter(c => !c.ok).length, completed:result.phase === 'complete', sourceUnchanged:result.sourceAfter === result.sourceBefore };
  if (!result.summary.completed || !result.summary.sourceUnchanged || result.cleanup.browserClosed !== true || result.cleanup.fixture?.closed !== true || result.cleanup.fixture?.childClosed !== true || result.cleanup.stages.some(s => s.listening || s.sockets) || result.cleanup.nativeFailed) process.exitCode = 1;
  await fs.writeFile(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2));
  process.stdout.write(JSON.stringify({ summary:result.summary, failure:result.failure, cleanup:result.cleanup, out:OUT }) + '\n');
}
