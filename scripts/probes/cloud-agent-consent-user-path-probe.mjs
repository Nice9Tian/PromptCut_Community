/**
 * True local VisuHive account app + actual compiled-by-Vite React Cloud panel in two
 * isolated Chrome contexts. Agent availability is controlled solely to expose the UI;
 * /agent/v1 is an explicit 503 sink, so this never claims model or runner readiness.
 * No account secret, cookie, access token, or draft text is written to output.
 * Run only in the root-granted 6650-6659 window after verifying all ten ports free.
 */
import '../lib/no-user-dirs.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { createServer as createViteServer } from 'vite';
// 这台 vite 不走 vite.config.ts，别名要自己挂（漏了的话浏览器侧 transform 500，页面打不开）
import { cloudSeamsPlugin } from '../../server/vite-plugin-cloud-seams.ts';
import react from '@vitejs/plugin-react';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 6650, ORIGIN = `http://127.0.0.1:${PORT}`;
const outIndex = process.argv.indexOf('--out');
const outPath = outIndex < 0 ? null : process.argv[outIndex + 1];
if (outIndex >= 0 && (!outPath || !path.isAbsolute(outPath) ||
  path.dirname(path.resolve(outPath)) !== path.resolve(os.tmpdir()) ||
  !/^pc-cloud-consent-shots-[a-f0-9]{12}$/.test(path.basename(outPath)))) throw Error('probe-out-must-be-new-tmp-subdir');
if (outPath) await fs.mkdir(outPath, { recursive:false });
const providerRoot = process.env.PROMPTCUT_ACCOUNT_PROVIDER_ROOT;
if (!providerRoot || !path.isAbsolute(providerRoot)) throw Error('PROMPTCUT_ACCOUNT_PROVIDER_ROOT-required');
const probeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-cloud-consent-'));
const profile = path.join(probeDir, 'chrome');
const results = { backend: 'real-vh-account-app', panel: 'real-react-controlled-availability', agent: '503-unavailable', checks: [], port: PORT,
  browserClosed: false, serverClosed: false };
if (outPath) results.screenshots = {};
const check = (condition, name) => { results.checks.push({ name, ok: Boolean(condition) }); assert.ok(condition, name); };
const portOpen = async (port, host) => new Promise(resolve => {
  const socket = net.connect({ port, host });
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
  socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
});
for (let port = 6650; port <= 6659; port++) {
  if (await portOpen(port, '127.0.0.1') || await portOpen(port, '::1')) throw Error(`protected-port-busy:${port}`);
}
const load = async rel => import(pathToFileURL(path.join(providerRoot, 'account', rel)).href);
const [{ openStore }, { createApp }, { createCredentials }] = await Promise.all([
  load('store.mjs'), load('app.mjs'), load('credentials.mjs'),
]);
const store = openStore(':memory:');
const now = Date.now;
const credentials = createCredentials({ store, now, key: randomBytes(32) });
const handleAccount = createApp({ store, credentials, now, origins: [ORIGIN], cookieSecure: false });
const accountCalls = [];
const agentRequests = [];
const pageErrors = [];
const missingPaths = [];
const vite = await createViteServer({ configFile: false, root: ROOT, plugins: [cloudSeamsPlugin(), react()], appType: 'custom',
  server: { middlewareMode: true, hmr: false, fs: { strict: true, deny: ['**/.git/**', '**/out/**', '**/.env*', '**/*.{pem,key,crt}'] } } });
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, ORIGIN).pathname;
  if (pathname.startsWith('/api/account/')) { accountCalls.push({ method:req.method, path:pathname }); void handleAccount(req, res); return; }
  if (pathname.startsWith('/agent/v1')) {
    agentRequests.push({ method: req.method, path: pathname });
    res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end('{"ok":false,"code":"agent-unavailable"}'); return;
  }
  if (pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end('<!doctype html><html><head><meta charset="utf-8"></head><body>Account setup outside editor</body></html>');
    return;
  }
  if (pathname === '/editor/' || pathname === '/editor/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end('<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/src/ai/cloud/consent-probe-harness.tsx"></script></body></html>');
    return;
  }
  if (!pathname.startsWith('/src/') && !pathname.startsWith('/server/') && !pathname.startsWith('/node_modules/') && !pathname.startsWith('/@') && !pathname.startsWith('/__vite')) {
    res.writeHead(404); res.end(); return;
  }
  vite.middlewares(req, res, () => { res.writeHead(404); res.end(); });
});
let browser = null, contexts = [];
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, '127.0.0.1', resolve); });
  const executablePath = await puppeteer.executablePath();
  await fs.access(executablePath);
  browser = await puppeteer.launch({ executablePath, headless: true, pipe: true,
    userDataDir: profile, args: [...PROBE_CHROME_ARGS, '--no-first-run'] });
  const password = `probe-${randomUUID()}-password`;
  const name = `consent_${randomBytes(5).toString('hex')}`;
  const first = await browser.createBrowserContext(); contexts.push(first);
  const pageA = await first.newPage();
  pageA.on('pageerror', error => pageErrors.push(String(error.message).slice(0, 240)));
  pageA.on('console', message => { if (message.type() === 'error') pageErrors.push(message.text().slice(0, 240)); });
  pageA.on('response', response => { if (response.status() === 404) missingPaths.push(new URL(response.url()).pathname); });
  await pageA.goto(ORIGIN, { waitUntil: 'domcontentloaded' });
  const registered = await pageA.evaluate(async ({ name, password }) => {
    const me = await (await fetch('/api/account/me', { credentials: 'same-origin' })).json();
    const response = await fetch('/api/account/register', { method:'POST', credentials:'same-origin',
      headers:{ 'content-type':'application/json', 'x-csrf-token':me.csrfToken },
      body:JSON.stringify({ name, password, requestId:crypto.randomUUID() }) });
    return { status:response.status, ok:(await response.json()).ok === true };
  }, { name, password });
  check(registered.status === 200 && registered.ok, 'real-account-register');
  const otherPassword = `probe-${randomUUID()}-password`;
  const otherName = `consent_${randomBytes(5).toString('hex')}`;
  const setup = await browser.createBrowserContext(); contexts.push(setup);
  const setupPage = await setup.newPage();
  await setupPage.goto(ORIGIN, { waitUntil:'domcontentloaded' });
  const otherRegistered = await setupPage.evaluate(async ({ name, password }) => {
    const me = await (await fetch('/api/account/me', { credentials:'same-origin' })).json();
    const response = await fetch('/api/account/register', { method:'POST', credentials:'same-origin',
      headers:{ 'content-type':'application/json', 'x-csrf-token':me.csrfToken },
      body:JSON.stringify({ name, password, requestId:crypto.randomUUID() }) });
    return { status:response.status, ok:(await response.json()).ok === true };
  }, { name:otherName, password:otherPassword });
  check(otherRegistered.status === 200 && otherRegistered.ok, 'other-account-outside-editor-register');
  await setup.close();
  await pageA.goto(`${ORIGIN}/editor/`, { waitUntil:'domcontentloaded' });
  await pageA.waitForFunction(() => Boolean(window.__pcConsentProbe), { timeout: 15_000 });
  check(await pageA.evaluate(() => window.__pcApiGuard === true && Array.isArray(window.__pcApiBlocked)), 'production-boot-api-guard-active');
  const mountedA = await pageA.evaluate(() => window.__pcConsentProbe.mount());
  check(mountedA.accountId.startsWith('acc_') && mountedA.oldDelegation === false, 'account-bound-no-old-delegation');
  await pageA.waitForSelector('[data-pc="cloud-agent-consent"]', { timeout: 20_000 });
  if (outPath) {
    const file = path.join(outPath, 'notice.png');
    await pageA.screenshot({ path:file });
    results.screenshots.notice = file;
  }
  check(agentRequests.length === 0, 'no-agent-info-read-before-consent');
  const notice = await pageA.$eval('[data-pc="cloud-agent-consent"] p', el => el.textContent);
  check(notice === '托管方能读到你和云端 Agent 的对话记录，包括私有对话', 'exact-notice');
  await pageA.type('[data-pc="ai-input"]', 'draft-kept-in-browser');
  await pageA.click('.pc-cloud-consent-actions button:first-child');
  await pageA.waitForFunction(() => !document.querySelector('[data-pc="cloud-agent-consent"]'));
  if (outPath) {
    const file = path.join(outPath, 'refusal.png');
    await pageA.screenshot({ path:file });
    results.screenshots.refusal = file;
  }
  check(await pageA.$eval('[data-pc="ai-input"]', el => el.value === 'draft-kept-in-browser'), 'reject-retains-draft');
  check(agentRequests.length === 0, 'reject-no-agent-read-send');
  check((await pageA.evaluate(() => window.__pcConsentProbe.status())).queued === 0, 'reject-no-local-queue');
  await pageA.click('[data-pc="ai-send"]');
  await pageA.waitForSelector('[data-pc="cloud-agent-consent"]', { timeout: 10_000 });
  check(await pageA.$eval('[data-pc="ai-input"]', el => el.value === 'draft-kept-in-browser'), 'next-use-prompts-with-draft');
  check(agentRequests.length === 0, 'retry-before-accept-no-agent-call');
  check((await pageA.evaluate(() => window.__pcConsentProbe.status())).queued === 0, 'retry-before-accept-no-local-queue');
  await pageA.click('.pc-cloud-consent-actions button:last-child');
  await pageA.waitForFunction(() => !document.querySelector('[data-pc="cloud-agent-consent"]'), { timeout: 10_000 });
  const consentA = await pageA.evaluate(async () => (await (await fetch('/api/account/cloud-agent-consent', { credentials:'same-origin' })).json()).accepted);
  check(consentA === true, 'server-persisted-accept');
  check(accountCalls.some(x => x.method === 'GET' && x.path === '/api/account/cloud-agent-consent') &&
    accountCalls.some(x => x.method === 'POST' && x.path === '/api/account/cloud-agent-consent') &&
    await pageA.evaluate(() => !window.__pcApiBlocked.includes('/api/account/cloud-agent-consent')),
  'real-consent-get-post-crossed-production-guard');
  const second = await browser.createBrowserContext(); contexts.push(second);
  const pageB = await second.newPage();
  pageB.on('pageerror', error => pageErrors.push(String(error.message).slice(0, 240)));
  await pageB.goto(`${ORIGIN}/editor/`, { waitUntil: 'domcontentloaded' });
  await pageB.waitForFunction(() => Boolean(window.__pcConsentProbe), { timeout: 15_000 });
  check(await pageB.evaluate(() => window.__pcApiGuard === true && Array.isArray(window.__pcApiBlocked)), 'second-device-production-guard-active');
  const logged = await pageB.evaluate(async ({ name, password }) => {
    const me = await (await fetch('/api/account/me', { credentials:'same-origin' })).json();
    const response = await fetch('/api/account/login', { method:'POST', credentials:'same-origin',
      headers:{ 'content-type':'application/json', 'x-csrf-token':me.csrfToken },
      body:JSON.stringify({ name, password, remember:false, requestId:crypto.randomUUID() }) });
    return { status:response.status, ok:(await response.json()).ok === true };
  }, { name, password });
  check(logged.status === 200 && logged.ok, 'second-device-real-login');
  const mountedB = await pageB.evaluate(() => window.__pcConsentProbe.mount());
  check(mountedB.accountId === mountedA.accountId && mountedB.oldDelegation === false, 'same-account-second-device-no-delegation');
  await pageB.waitForFunction(() => window.__pcConsentProbe.status().accepted === true, { timeout: 10_000 });
  check(await pageB.$('[data-pc="cloud-agent-consent"]') === null, 'second-device-does-not-prompt');
  await pageA.evaluate(() => window.__pcConsentProbe.logout());
  await pageA.waitForFunction(() => !document.querySelector('[data-pc="cloud-agent-consent"]'), { timeout: 10_000 });
  check(agentRequests.every(x => x.method !== 'POST'), 'no-model-or-send-without-agent-service');
  const otherLogged = await pageA.evaluate(async ({ name, password }) => {
    const me = await (await fetch('/api/account/me', { credentials:'same-origin' })).json();
    const response = await fetch('/api/account/login', { method:'POST', credentials:'same-origin',
      headers:{ 'content-type':'application/json', 'x-csrf-token':me.csrfToken },
      body:JSON.stringify({ name, password, remember:false, requestId:crypto.randomUUID() }) });
    return { status:response.status, ok:(await response.json()).ok === true };
  }, { name:otherName, password:otherPassword });
  check(otherLogged.status === 200 && otherLogged.ok, 'same-tab-other-account-real-login-through-guard');
  const otherMounted = await pageA.evaluate(() => window.__pcConsentProbe.mount());
  check(otherMounted.accountId !== mountedA.accountId && otherMounted.oldDelegation === false, 'account-switch-new-binding-no-delegation');
  await pageA.waitForSelector('[data-pc="cloud-agent-consent"]', { timeout: 10_000 });
  check(await pageA.$eval('[data-pc="ai-input"]', el => el.value === ''), 'other-account-cannot-see-old-draft');
  check((await pageA.evaluate(() => window.__pcConsentProbe.status())).queued === 0 && agentRequests.every(x => x.method !== 'POST'),
    'other-account-has-no-old-queue-or-agent-send');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  if (browser) { await browser.close(); results.browserClosed = true; }
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
  results.serverClosed = !server.listening;
  await vite.close();
  store.close();
  const relative = path.relative(os.tmpdir(), probeDir);
  if (relative.startsWith('pc-cloud-consent-') && !relative.includes(path.sep)) await fs.rm(probeDir, { recursive:true, force:true });
  results.portClosed = !await portOpen(PORT, '127.0.0.1');
  results.pageErrors = pageErrors.slice(0, 5);
  results.missingPaths = missingPaths.slice(0, 10);
  console.log(JSON.stringify(results));
}
check(results.portClosed, 'owned-port-closed');
