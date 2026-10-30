/**
 * 断网待发的浏览器探针(2026-10-22 用户定,`docs/semantics/workflow/production.md`「云端对话」断网时发消息那一条)。
 *
 * 挂真的 `CloudAiPanel`(账号模式,`src/ai/cloud/offline-queue-probe-harness.tsx`),Agent 服务由本脚本模拟(消息清单、发送、事件流)。
 * 断网 = 浏览器离线模式 + 服务端同时掐掉事件流(应用层模拟,不碰宿主机网络)。逐条验:
 *   1. 断网时发两条:不报错,气泡照常显示、下面写「等网络恢复后发出」,服务端一条没收到;
 *   2. 网络恢复后不用再点就按顺序发出;
 *   3. 断网时发一条,期间「另一台设备」在这个对话里发了一条:恢复后不发,气泡标「发送失败」带「重新发送」;
 *   4. 点「重新发送」按当前状态重走 → 发出;
 *   5. 排着的消息跨页面刷新还在,恢复后发出(〔裁〕三级)。
 * 截图写到 `out/offline-queue/`。
 *
 * 跑:node scripts/probes/cloud-offline-queue-probe.mjs [--port 5900]
 * 端口:只用传入的那一个(缺省 5900),先确认空着。通过标准:结果 JSON 里 `ok: true`、每一项 `pass: true`、页面没有报错。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { createServer as createViteServer } from 'vite';
// 这台 vite 不走 vite.config.ts，别名要自己挂（漏了的话浏览器侧 transform 500，页面打不开）
import { cloudSeamsPlugin } from '../../server/vite-plugin-cloud-seams.ts';
import react from '@vitejs/plugin-react';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const portArg = process.argv.indexOf('--port');
const PORT = portArg > 0 ? Number(process.argv[portArg + 1]) : 5900;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const OUT = path.join(ROOT, 'out', 'offline-queue');
const ACCOUNT = 'acc-a';
const PROJECT = `sp_${'a'.repeat(26)}`;
const CONV = 'cc-offline-probe';
const TAB = 'offline-probe';

const portOpen = (port) => new Promise((resolve) => {
  const socket = net.connect({ port, host: '127.0.0.1' });
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
});
if (await portOpen(PORT)) throw Error(`port-busy:${PORT}`);
await fs.mkdir(OUT, { recursive: true });

/* ---------------- 模拟的 Agent 服务 ---------------- */
const agent = {
  seq: 1,
  messages: [{ messageId: 'm-seed', requestId: 'seed', arrivalSeq: 1, senderAccountId: ACCOUNT, senderNameAtSend: '探针 A', content: '已有的一条' }],
  streams: new Set(),
  posts: [],
  blockMeta: false,
};
const userEvent = (m) => ({ type: 'user', seq: m.arrivalSeq, messageId: m.messageId, prompt: m.content, senderAccountId: m.senderAccountId,
  senderNameAtSend: m.senderNameAtSend, projectId: PROJECT, conversationId: CONV });
function broadcast(m) { for (const res of agent.streams) res.write(`data: ${JSON.stringify(userEvent(m))}\n\n`); }
function dropStreams() { for (const res of [...agent.streams]) { agent.streams.delete(res); res.destroy(); } }
function addMessage({ requestId, content, senderAccountId = ACCOUNT, senderNameAtSend = '探针 A' }) {
  const prior = agent.messages.find((m) => m.requestId === requestId);
  if (prior) return prior;
  const m = { messageId: `m-${++agent.seq}`, requestId, arrivalSeq: agent.seq, senderAccountId, senderNameAtSend, content };
  agent.messages.push(m);
  broadcast(m);
  return m;
}
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve) => { let s = ''; req.on('data', (c) => { s += c; }); req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } }); });

async function handleAgent(req, res, pathname) {
  const rest = pathname.slice('/agent/v1'.length);
  if (rest === '/info') return json(res, 200, { ok: true, enabled: true, accountMode: true, models: [], running: [], limits: {} });
  if (rest === '/conversations' && req.method === 'GET') return json(res, 200, { ok: true, items: [{ id: CONV, projectId: PROJECT, ownerAccountId: ACCOUNT,
    visibility: 'shared', title: '探针对话', updatedAt: Date.now(), state: 'idle', lastSeq: agent.seq, queueRevision: agent.seq }] });
  if (rest === `/conversations/${CONV}` && req.method === 'GET') {
    if (agent.blockMeta) return json(res, 503, { ok: false, code: 'unavailable' });
    return json(res, 200, { ok: true, meta: { id: CONV, projectId: PROJECT, messages: agent.messages.map((m) => ({ ...m })) } });
  }
  if (rest === `/conversations/${CONV}/messages` && req.method === 'POST') {
    const body = await readBody(req);
    agent.posts.push({ requestId: body.requestId, prompt: body.prompt });
    const m = addMessage({ requestId: body.requestId, content: body.prompt });
    return json(res, 202, { ok: true, messageId: m.messageId, runId: null, seq: m.arrivalSeq, queuePosition: 1, queueRevision: m.arrivalSeq,
      conversation: { id: CONV, projectId: PROJECT } });
  }
  if (rest === `/conversations/${CONV}/events`) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.flushHeaders?.();
    const after = Number(new URL(req.url, ORIGIN).searchParams.get('after') ?? 0);
    for (const m of agent.messages) if (m.arrivalSeq > after) res.write(`data: ${JSON.stringify(userEvent(m))}\n\n`);
    agent.streams.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 10_000);
    res.on('close', () => { clearInterval(ping); agent.streams.delete(res); });
    return undefined;
  }
  return json(res, 200, { ok: true, items: [] });
}

// 依赖可能装在上层目录(worktree 向上解析):放行它;预构建缓存放系统临时目录,不在仓库里建 node_modules
const vite = await createViteServer({ configFile: false, root: ROOT, plugins: [cloudSeamsPlugin(), react()], appType: 'custom', logLevel: 'error',
  cacheDir: path.join(os.tmpdir(), 'pc-offline-queue-vite'),
  server: { middlewareMode: true, hmr: false, fs: { strict: true, allow: [ROOT, path.resolve(path.dirname(fileURLToPath(import.meta.resolve('vite'))), '../../..')],
    deny: ['**/.git/**', '**/out/**', '**/.env*', '**/*.{pem,key,crt}'] } } });
const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, ORIGIN);
  if (pathname.startsWith('/agent/v1')) { void handleAgent(req, res, pathname); return; }
  if (pathname === '/probe-account/consent') return json(res, 200, { ok: true, accountId: ACCOUNT, accepted: true, noticeVersion: 1, acceptedAt: 1 });
  if (pathname === '/editor/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end('<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/src/ai/cloud/offline-queue-probe-harness.tsx"></script></body></html>');
    return;
  }
  if (!pathname.startsWith('/src/') && !pathname.startsWith('/server/') && !pathname.startsWith('/node_modules/') && !pathname.startsWith('/@') && !pathname.startsWith('/__vite')) { res.writeHead(404); res.end(); return; }
  vite.middlewares(req, res, () => { res.writeHead(404); res.end(); });
});

const results = { port: PORT, checks: [], shots: [], pageErrors: [] };
const check = (pass, name, detail) => { results.checks.push({ name, pass: Boolean(pass), ...(detail !== undefined ? { detail } : {}) }); if (!pass) throw Error(`check-failed:${name}:${JSON.stringify(detail ?? null)}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, ms = 20_000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw Error(`timeout:${what}`); await sleep(100); } }

let browser = null;
let debugPage = null;
const requests = [];
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-offline-queue-'));
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, '127.0.0.1', resolve); });
  browser = await puppeteer.launch({ executablePath: await puppeteer.executablePath(), headless: true, pipe: true, userDataDir: profile,
    args: [...PROBE_CHROME_ARGS, '--no-first-run'] });
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  debugPage = page;
  page.on('requestfailed', (r) => requests.push(`FAIL ${r.url()} ${r.failure()?.errorText}`));
  page.on('response', (r) => { if (r.status() >= 400) requests.push(`${r.status()} ${r.url()}`); });
  await page.setViewport({ width: 420, height: 760, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => results.pageErrors.push(String(e.message).slice(0, 240)));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_INTERNET_DISCONNECTED|net::/.test(m.text())) results.pageErrors.push(m.text().slice(0, 240)); });
  await page.evaluateOnNewDocument((k, v) => { try { if (!localStorage.getItem(k)) localStorage.setItem(k, v); } catch { /* */ } },
    `pc.cloudChat:${ACCOUNT}:${PROJECT}:${TAB}`, CONV);
  await page.goto(`${ORIGIN}/editor/`, { waitUntil: 'domcontentloaded' });

  const bubbles = () => page.$$eval('.ai-message.user', (els) => els.map((el) => ({
    text: el.querySelector('.ai-message-text')?.textContent?.trim() ?? '',
    state: el.querySelector('[data-pc="cloud-send-state"]')?.getAttribute('data-state') ?? null,
    stateText: el.querySelector('[data-pc="cloud-send-state"]')?.textContent?.trim() ?? null,
    failed: el.querySelector('[data-pc="cloud-send-failed"]')?.textContent?.trim() ?? null,
    resend: Boolean(el.querySelector('[data-pc="cloud-resend"]')),
  })));
  const find = async (text) => (await bubbles()).find((b) => b.text === text);
  const send = async (text) => {
    await page.waitForSelector('[data-pc="ai-input"]:not([disabled])');
    await page.click('[data-pc="ai-input"]');
    await page.type('[data-pc="ai-input"]', text);
    await page.keyboard.press('Enter');
  };
  const goOffline = async () => { await page.setOfflineMode(true); dropStreams(); await page.waitForFunction(() => navigator.onLine === false); };
  const goOnline = async () => { await page.setOfflineMode(false); };
  const shot = async (name) => { const file = path.join(OUT, name); await page.screenshot({ path: file }); results.shots.push(path.relative(ROOT, file)); };
  const outbox = () => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '[]'), `pc.cloudOutbox:${ACCOUNT}:${PROJECT}:${TAB}`);

  await waitFor(() => find('已有的一条'), 'seed-bubble');
  await page.waitForSelector('[data-pc="ai-input"]');
  check(true, 'mounted-real-panel');

  /* 1. 断网时发两条:不报错、排着、气泡写「等网络恢复后发出」 */
  await goOffline();
  await send('断网时发的第一条');
  await send('断网时发的第二条');
  const queued = await waitFor(async () => { const a = await find('断网时发的第一条'); const b = await find('断网时发的第二条');
    return a?.state === 'queued' && b?.state === 'queued' ? [a, b] : null; }, 'queued-bubbles');
  check(queued.every((b) => b.stateText === '等网络恢复后发出' && !b.failed), '1-queued-bubble-text', queued);
  const notice = await page.$eval('body', (b) => b.innerText);
  check(!/没有发出去|请检查网络/.test(notice), '1-no-error-shown');
  check(agent.posts.length === 0, '1-server-received-nothing', [...agent.posts]);
  const stored = await outbox();
  check(stored.map((x) => x.text).join('|') === '断网时发的第一条|断网时发的第二条' && stored.every((x) => x.baseline?.messageId === 'm-seed' || x.baseline?.requestId),
    '1-stored-in-order-with-baseline', stored.map((x) => ({ text: x.text, baseline: x.baseline })));
  await shot('01-queued.png');

  /* 2. 恢复后自动发出,按顺序 */
  await goOnline();
  await waitFor(() => agent.posts.length >= 2, 'auto-sent', 30_000);
  check(agent.posts.map((p) => p.prompt).join('|') === '断网时发的第一条|断网时发的第二条', '2-auto-sent-in-order', agent.posts.map((p) => p.prompt));
  await waitFor(async () => { const list = await bubbles(); return list.filter((b) => b.text.startsWith('断网时发的')).every((b) => !b.state && !b.failed) ? list : null; }, 'settled');
  check((await outbox()).length === 0, '2-outbox-empty');
  await shot('02-sent.png');

  /* 3. 离线期间另一台设备发过:不发,标「发送失败」带「重新发送」 */
  await goOffline();
  await send('断网时发的第三条');
  await waitFor(async () => (await find('断网时发的第三条'))?.state === 'queued', 'third-queued');
  addMessage({ requestId: 'other-device-1', content: '另一台设备发的', senderAccountId: ACCOUNT, senderNameAtSend: '探针 A(手机)' });
  const before = agent.posts.length;
  await goOnline();
  const failed = await waitFor(async () => { const b = await find('断网时发的第三条'); return b?.failed ? b : null; }, 'third-failed', 30_000);
  check(failed.failed.startsWith('发送失败') && failed.resend, '3-failed-with-resend', failed);
  check(agent.posts.length === before && !agent.messages.some((m) => m.content === '断网时发的第三条'), '3-not-sent', agent.posts.map((p) => p.prompt));
  await waitFor(() => find('另一台设备发的'), 'other-device-bubble-visible');
  await shot('03-failed.png');

  /* 4. 重新发送:按当前状态重走(最近一条已是「另一台设备发的」)→ 发出 */
  await page.click('[data-pc="cloud-resend"]');
  await waitFor(() => agent.messages.some((m) => m.content === '断网时发的第三条'), 'resent', 30_000);
  const order = agent.messages.map((m) => m.content);
  check(order.indexOf('断网时发的第三条') > order.indexOf('另一台设备发的'), '4-resent-after-other', order);
  await waitFor(async () => { const b = await find('断网时发的第三条'); return b && !b.failed && !b.state ? b : null; }, 'resent-settled');
  await shot('04-resent.png');

  /* 5. 跨页面刷新:排着时刷新,气泡还在、仍写「等网络恢复后发出」,恢复后发出 */
  await goOffline();
  await send('刷新前排着的');
  await waitFor(async () => (await find('刷新前排着的'))?.state === 'queued', 'fifth-queued');
  agent.blockMeta = true; // 服务端暂时不可用:恢复联网后核对这一步一直 503,消息留着
  await goOnline();
  await sleep(1500);
  check(!agent.messages.some((m) => m.content === '刷新前排着的'), '5-held-while-service-unavailable');
  await page.reload({ waitUntil: 'domcontentloaded' });
  const restored = await waitFor(async () => { const b = await find('刷新前排着的'); return b?.state === 'queued' ? b : null; }, 'restored-after-reload');
  check(restored.stateText === '等网络恢复后发出', '5-restored-after-reload', restored);
  await shot('05-after-reload.png');
  agent.blockMeta = false;
  await waitFor(() => agent.messages.some((m) => m.content === '刷新前排着的'), 'fifth-sent', 60_000);
  check(agent.messages.filter((m) => m.content === '刷新前排着的').length === 1, '5-sent-once');


  /* 6. 手机版 Agent 分页(真的 AgentChat):排队、发送失败带重新发送、点了发出 */
  const mctx = await browser.createBrowserContext();
  const m = await mctx.newPage();
  debugPage = m;
  await m.setViewport({ width: 375, height: 812, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  m.on('pageerror', (e) => results.pageErrors.push(`mobile: ${String(e.message).slice(0, 240)}`));
  m.on('console', (x) => { if (x.type() === 'error' && !/Failed to load resource|ERR_INTERNET_DISCONNECTED|net::/.test(x.text())) results.pageErrors.push(`mobile: ${x.text().slice(0, 240)}`); });
  await m.evaluateOnNewDocument((k, v) => { try { if (!localStorage.getItem(k)) localStorage.setItem(k, v); } catch { /* */ } },
    `pc.cloudChat:${ACCOUNT}:${PROJECT}:${TAB}`, CONV);
  await m.goto(`${ORIGIN}/editor/?ui=mobile`, { waitUntil: 'domcontentloaded' });
  const mBubbles = () => m.$$eval('[data-pcm="msg-me"]', (els) => els.map((el) => ({
    text: el.querySelector('.plain')?.textContent?.trim() ?? '',
    queued: el.querySelector('[data-pcm="send-queued"]')?.textContent?.trim() ?? null,
    failed: el.querySelector('[data-pcm="send-failed"]')?.textContent?.trim() ?? null,
    resend: Boolean(el.querySelector('[data-pcm="resend"]')),
  })));
  const mFind = async (text) => (await mBubbles()).find((b) => b.text === text);
  const mSend = async (text) => {
    await m.waitForSelector('[data-pcm="chat-input"]:not([disabled])');
    await m.click('[data-pcm="chat-input"]');
    await m.type('[data-pcm="chat-input"]', text);
    await m.click('[data-pcm="chat-send"]');
  };
  await waitFor(() => mFind('断网时发的第三条'), 'mobile-history');
  await m.setOfflineMode(true); dropStreams(); await m.waitForFunction(() => navigator.onLine === false);
  await mSend('手机断网时发的一条');
  await mSend('手机断网时发的第二条');
  const mq = await waitFor(async () => { const a = await mFind('手机断网时发的一条'); const b = await mFind('手机断网时发的第二条');
    return a?.queued && b?.queued ? [a, b] : null; }, 'mobile-queued');
  check(mq.every((b) => b.queued === '等网络恢复后发出' && !b.failed), '6-mobile-queued', mq);
  check(!agent.posts.some((x) => x.prompt.startsWith('手机断网')), '6-mobile-server-received-nothing');
  { const file = path.join(OUT, 'mobile-01-queued.png'); await m.screenshot({ path: file }); results.shots.push(path.relative(ROOT, file)); }
  addMessage({ requestId: 'other-device-2', content: '电脑上发的', senderAccountId: ACCOUNT, senderNameAtSend: '探针 A(电脑)' });
  await m.setOfflineMode(false);
  const mf = await waitFor(async () => { const a = await mFind('手机断网时发的一条'); const b = await mFind('手机断网时发的第二条');
    return a?.failed && b?.failed ? [a, b] : null; }, 'mobile-failed', 30_000);
  check(mf.every((b) => b.failed.startsWith('发送失败') && b.resend), '6-mobile-failed-with-resend', mf);
  check(!agent.messages.some((x) => x.content.startsWith('手机断网')), '6-mobile-not-sent');
  await waitFor(() => mFind('电脑上发的'), 'mobile-other-visible');
  { const file = path.join(OUT, 'mobile-02-failed.png'); await m.screenshot({ path: file }); results.shots.push(path.relative(ROOT, file)); }
  await m.click('[data-pcm="resend"]');
  await waitFor(() => agent.messages.some((x) => x.content === '手机断网时发的一条'), 'mobile-resent', 30_000);
  check((await mFind('手机断网时发的第二条'))?.resend === true && !agent.messages.some((x) => x.content === '手机断网时发的第二条'),
    '6-mobile-resend-only-that-one');
  await waitFor(async () => { const b = await mFind('手机断网时发的一条'); return b && !b.failed && !b.queued ? b : null; }, 'mobile-resent-settled');
  { const file = path.join(OUT, 'mobile-03-resent.png'); await m.screenshot({ path: file }); results.shots.push(path.relative(ROOT, file)); }

  check(results.pageErrors.length === 0, 'no-page-errors', results.pageErrors);
  results.ok = true;
} catch (error) {
  results.ok = false;
  results.error = String(error?.stack ?? error).slice(0, 2000);
  try {
    if (debugPage) {
      await debugPage.screenshot({ path: path.join(OUT, 'fail.png') });
      results.failText = (await debugPage.$eval('body', (b) => b.innerText)).slice(0, 1500);
    }
  } catch { /* */ }
  results.requests = requests.slice(-30);
} finally {
  try { await browser?.close(); } catch { /* */ }
  dropStreams();
  await new Promise((r) => server.close(() => r()));
  await vite.close();
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}
await fs.writeFile(path.join(OUT, 'result.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
process.exitCode = results.ok ? 0 : 1;
assert.ok(true);
