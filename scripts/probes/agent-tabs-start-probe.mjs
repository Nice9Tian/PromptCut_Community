/**
 * AI 栏 Agent 分页按项目分开 + 没有会话时的开始页探针(用户 2026-10-22 定:A09 会话都能关、没有会话显示开始页;A10 分页清单按项目分开)。
 * 真 Chrome(puppeteer),编辑台 `?editor&aimock=1&nosetup=1`:AI 栏走页面内置假流,不调真模型、不花额度,也不要任何模型后端。
 *
 * 用法:
 *   node scripts/probes/agent-tabs-start-probe.mjs [--port 5980] [--out out/agent-tabs-start-probe] [--origin http://127.0.0.1:N] [--keep]
 *
 * 缺省自己起一台编辑器(`vite --port <port> --strictPort`,舞台占 +1、+2;PROMPTCUT_NO_PORT_FILE=1;会话 / 工作 / 数据 / AI 配置目录都指到临时目录),
 * 跑完结束自己起的进程树。`--origin` 改用外面现成的编辑器(不起进程)。
 *
 * 验收(每项一行 JSON,最后一行 { summary },有失败退出码 1):
 *   S1 新项目进来:右栏竖栏只有一项「开始」(draft),AI 栏是开始页,带引导动画(光点、箭头、输入框描边脉动);
 *      没有 Agent 分页、存储里没有这个项目的清单、没发任何聊天请求。
 *   S2 点预设「做一个动画告诉我使用软件可以干什么」:编辑框里出现这句话,发送按钮开始闪(composer.is-guide-send);还没建会话。
 *   S3 点发送:这时才出现 Agent 1 分页(内部 id 是「项目ID_AgentID」),开始页换成对话,用户那条消息在里面;竖栏上「开始」没了。
 *   S4 项目 A 再开 Agent 2;切到新项目 B:竖栏是 B 自己的(开始页,带引导动画),不见 A 的两个分页;B 点发送得到 B 的 Agent 1;
 *      切回 A:Agent 1、Agent 2 还在。
 *   S5 把 A 的分页全关掉(最后一个的 × 可点、不再有「至少保留」的提示):回到开始页,不带引导动画(只有预设和编辑框),
 *      点预设照样往编辑框放那句话;关光过按项目记:B 仍带引导动画。
 *   S6 刷新页面再把 A 的项目对象载回去:A 仍是「关光过」的开始页(不带动画);B 载回去:Agent 1 还在。
 *   S7 prefers-reduced-motion:引导动画全部关掉(光点、箭头、描边都没有 animation)。
 *   (在线构建里的开始页和手机版 Agent 分页另见 agent-tabs-start-mobile-probe.mjs。)
 * 截图写进 --out:s1-start-animated.png、s2-after-preset.png、s3-after-send.png、s4-rail-a.png、s4-rail-b.png、
 *   s4-rail-a-again.png、s5-cleared.png、s5-cleared-after-preset.png、s6-reload-cleared.png、s8-mobile-agent.png。
 */
import '../lib/no-user-dirs.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { flagArg } from './probe-connect.mjs';
import { startDevServer, REPO } from '../lib/dev-server.mjs';

const PORT = Number(flagArg('port', 5980));
if (PORT < 5980 || PORT > 5989) throw new Error(`端口 ${PORT} 不在分给本探针的 5980～5989 里`);
const OUT = path.resolve(REPO, flagArg('out', 'out/agent-tabs-start-probe'));
const KEEP = process.argv.includes('--keep');
const GIVEN_ORIGIN = flagArg('origin', null);
fs.mkdirSync(OUT, { recursive: true });

const PRESET = '做一个动画告诉我使用软件可以干什么';
const results = [];
const check = (name, ok, extra = {}) => {
  const r = { check: name, ok: !!ok, ...extra };
  results.push(r);
  console.log(JSON.stringify(r));
  return !!ok;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`等 ${what} 超时`);
    await sleep(150);
  }
}

let server = null;
let tmp = null;
let browser = null;
try {
  let origin = GIVEN_ORIGIN;
  if (!origin) {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-agent-tabs-start-'));
    server = await startDevServer({
      port: PORT,
      logFile: path.join(tmp, 'vite.log'),
      env: {
        PROMPTCUT_NO_PORT_FILE: '1',
        PROMPTCUT_PUSH: '0',
        PROMPTCUT_CHATS_DIR: path.join(tmp, 'chats'),
        PROMPTCUT_WORK_DIR: path.join(tmp, 'work'),
        PROMPTCUT_DATA_DIR: path.join(tmp, 'data'),
        PROMPTCUT_AI_CONFIG: path.join(tmp, 'ai.json'),
      },
    });
    origin = server.origin;
  }

  browser = await puppeteer.launch({
    headless: true,
    defaultViewport: { width: 1440, height: 900 },
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--force-device-scale-factor=1'],
  });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e?.message ?? e)));
  page.on('dialog', (d) => { void d.accept().catch(() => {}); });
  const chatRequests = [];
  page.on('request', (r) => { if (/\/api\/ai\/chat|\/agent\/v1\//.test(r.url())) chatRequests.push(r.url()); });
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${origin}/?editor&aimock=1&nosetup=1`, { waitUntil: 'domcontentloaded' });
  await waitFor(() => page.$('[data-pc="ai-start"]'), 120_000, '开始页');
  await waitFor(() => page.evaluate(() => !!window.__pcStore), 60_000, 'window.__pcStore');
  await sleep(800);

  const projectId = () => page.evaluate(() => window.__pcStore.getState().project.id);
  const railTabs = () => page.evaluate(() => [...document.querySelectorAll('nav[data-pc="right-rail"] [data-pc-agent-tab]')].map((b) => ({
    id: b.getAttribute('data-pc-agent-tab'),
    draft: b.getAttribute('data-pc-agent-draft') === '1',
    label: b.querySelector('.pc-rr-label')?.textContent ?? '',
    on: b.classList.contains('is-on'),
  })));
  const startState = () => page.evaluate(() => {
    const el = document.querySelector('[data-pc="ai-start"]');
    const visible = (n) => !!n && n.getClientRects().length > 0;
    const composer = [...document.querySelectorAll('[data-pc="ai-composer"]')].find(visible) ?? null;
    return {
      start: visible(el),
      animated: el?.getAttribute('data-pc-start-animated') === '1',
      orb: visible(document.querySelector('[data-pc="ai-start-orb"]')),
      cue: visible(document.querySelector('[data-pc="ai-start-cue"]')),
      guide: composer?.getAttribute('data-pc-guide') ?? null,
      text: [...document.querySelectorAll('[data-pc="ai-input"]')].find(visible)?.value ?? null,
    };
  });
  const storedList = (pid) => page.evaluate((pid) => localStorage.getItem(`pc.agentTabs:${pid}`), pid);
  // 载入项目后卡片测量遮罩("正在测量卡片")会盖住整个界面几秒:等它撤了再截图
  const shot = async (name, selector = null) => {
    await waitFor(() => page.evaluate(() => !document.body.innerText.includes('正在测量卡片')), 60_000, '测量遮罩撤掉').catch(() => {});
    await sleep(300);
    return selector ? page.$(selector).then((h) => h?.screenshot({ path: path.join(OUT, name) })) : page.screenshot({ path: path.join(OUT, name) });
  };
  const clickVisible = async (sel) => {
    const ok = await page.evaluate((sel) => {
      const el = [...document.querySelectorAll(sel)].find((n) => n.getClientRects().length > 0);
      if (!el) return false;
      el.click();
      return true;
    }, sel);
    if (!ok) throw new Error(`点不到 ${sel}`);
  };

  /* ── S1 新项目进来:开始页,带引导动画 ── */
  const pidA = await projectId();
  const s1rail = await railTabs();
  const s1 = await startState();
  check('S1.rail-only-start', s1rail.length === 1 && s1rail[0].draft && s1rail[0].label === '开始' && s1rail[0].id.startsWith(`${pidA}_`), { s1rail });
  check('S1.start-page-animated', s1.start && s1.animated && s1.orb && s1.cue && s1.guide === 'input', s1);
  check('S1.no-list-stored', (await storedList(pidA)) === null);
  check('S1.no-chat-request', chatRequests.length === 0, { chatRequests });
  await shot('s1-start-animated.png');

  /* ── S2 点预设 ── */
  await clickVisible('[data-pc="ai-start-preset"]');
  await waitFor(async () => (await startState()).text === PRESET, 5000, '预设进编辑框');
  const s2 = await startState();
  check('S2.preset-in-input', s2.text === PRESET, s2);
  check('S2.send-button-guided', s2.guide === 'send', s2);
  check('S2.still-no-session', (await railTabs()).every((t) => t.draft) && (await storedList(pidA)) === null && chatRequests.length === 0);
  await shot('s2-after-preset.png');

  /* ── S3 点发送:这时才建 Agent 1 ── */
  await clickVisible('[data-pc="ai-send"]');
  await waitFor(async () => (await railTabs()).some((t) => !t.draft), 8000, 'Agent 1 分页');
  const s3rail = await railTabs();
  check('S3.agent1-created', s3rail.length === 1 && !s3rail[0].draft && s3rail[0].label === 'Agent 1' && s3rail[0].id.startsWith(`${pidA}_`), { s3rail });
  await waitFor(() => page.evaluate((txt) => [...document.querySelectorAll('[data-pc-msg]')].some((n) => n.textContent.includes(txt)), PRESET), 8000, '用户那条消息');
  check('S3.message-sent-in-session', true);
  check('S3.start-page-gone', !(await startState()).start);
  const a1 = s3rail[0].id;
  const stored3 = JSON.parse((await storedList(pidA)) ?? 'null');
  check('S3.list-stored-per-project', !!stored3 && stored3.tabs.length === 1 && stored3.tabs[0].id === a1 && stored3.cleared === false, stored3);
  // 假流跑完,免得关页时弹确认
  await waitFor(() => page.evaluate(() => !document.querySelector('[data-pc="ai-stop"]')), 30_000, '假流结束');
  await shot('s3-after-send.png');

  /* ── S4 项目 A 再开 Agent 2;切到 B;B 点发送;切回 A ── */
  await clickVisible('[data-pc="agent-tab-add"]');
  await waitFor(async () => (await railTabs()).length === 2, 5000, 'Agent 2');
  const s4a = await railTabs();
  check('S4.A-has-two', s4a.map((t) => t.label).join() === 'Agent 1,Agent 2', { s4a });
  await shot('s4-rail-a.png', 'nav[data-pc="right-rail"]');
  await shot('s4-page-a.png');
  const projA = await page.evaluate(() => JSON.parse(JSON.stringify(window.__pcStore.getState().project)));
  await page.evaluate(() => window.__pcStore.actions.newProject('项目 B'));
  await waitFor(async () => (await railTabs()).some((t) => t.draft), 8000, 'B 的开始页');
  const pidB = await projectId();
  const s4b = await railTabs();
  const s4bStart = await startState();
  check('S4.B-own-list', pidB !== pidA && s4b.length === 1 && s4b[0].draft && s4b[0].id.startsWith(`${pidB}_`), { s4b });
  check('S4.B-start-animated', s4bStart.start && s4bStart.animated && s4bStart.orb, s4bStart);
  await shot('s4-rail-b.png', 'nav[data-pc="right-rail"]');
  await shot('s4-page-b.png');
  await clickVisible('[data-pc="ai-start-preset"]');
  await clickVisible('[data-pc="ai-send"]');
  await waitFor(async () => (await railTabs()).some((t) => !t.draft), 8000, 'B 的 Agent 1');
  const s4b2 = await railTabs();
  check('S4.B-agent1', s4b2.length === 1 && s4b2[0].label === 'Agent 1' && s4b2[0].id.startsWith(`${pidB}_`) && s4b2[0].id !== a1, { s4b2 });
  const projB = await page.evaluate(() => JSON.parse(JSON.stringify(window.__pcStore.getState().project)));
  await waitFor(() => page.evaluate(() => !document.querySelector('[data-pc="ai-stop"]')), 30_000, 'B 假流结束');
  await page.evaluate((p) => window.__pcStore.actions.loadProject(p), projA);
  await waitFor(async () => (await railTabs()).length === 2, 8000, '切回 A');
  const s4a2 = await railTabs();
  check('S4.A-back', s4a2.map((t) => t.label).join() === 'Agent 1,Agent 2' && s4a2.every((t) => t.id.startsWith(`${pidA}_`)), { s4a2 });
  await shot('s4-rail-a-again.png', 'nav[data-pc="right-rail"]');

  /* ── S5 把 A 的分页全关掉 ── */
  const lastCloseDisabled = [];
  for (let i = 0; i < 2; i++) {
    const info = await page.evaluate(() => {
      const xs = [...document.querySelectorAll('nav[data-pc="right-rail"] .pc-rr-x')];
      const x = xs[xs.length - 1];
      return x ? { disabled: x.disabled, title: x.title, n: xs.length } : null;
    });
    lastCloseDisabled.push(info);
    await page.evaluate(() => {
      const xs = [...document.querySelectorAll('nav[data-pc="right-rail"] .pc-rr-x')];
      xs[xs.length - 1]?.click();
    });
    await sleep(400);
  }
  check('S5.last-close-enabled', lastCloseDisabled[1]?.n === 1 && lastCloseDisabled[1]?.disabled === false && !/至少保留/.test(lastCloseDisabled[1]?.title ?? ''), { lastCloseDisabled });
  await waitFor(async () => (await railTabs()).every((t) => t.draft), 8000, '回到开始页');
  const s5 = await startState();
  const s5rail = await railTabs();
  check('S5.back-to-start-no-animation', s5rail.length === 1 && s5rail[0].draft && s5.start && !s5.animated && !s5.orb && !s5.cue && s5.guide === null, { s5, s5rail });
  const stored5 = JSON.parse((await storedList(pidA)) ?? 'null');
  check('S5.cleared-remembered-for-A', !!stored5 && stored5.tabs.length === 0 && stored5.cleared === true, stored5);
  await shot('s5-cleared.png');
  await clickVisible('[data-pc="ai-start-preset"]');
  await waitFor(async () => (await startState()).text === PRESET, 5000, '关光后预设进编辑框');
  const s5b = await startState();
  check('S5.preset-works-when-cleared', s5b.text === PRESET && s5b.guide === 'send' && !s5b.animated, s5b);
  await shot('s5-cleared-after-preset.png');
  // 关光过按项目记:B 仍带引导动画(B 的 Agent 1 关掉之前先切过去验:B 还有会话,所以只验存储里 B 没记关光)
  const storedB = JSON.parse((await storedList(pidB)) ?? 'null');
  check('S5.cleared-is-per-project', !!storedB && storedB.cleared === false && storedB.tabs.length === 1, storedB);

  /* ── S6 刷新后把项目载回去 ── */
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitFor(() => page.evaluate(() => !!window.__pcStore), 120_000, '刷新后的 store');
  await sleep(1500);
  await page.evaluate((p) => window.__pcStore.actions.loadProject(p), projA);
  await waitFor(async () => (await railTabs()).some((t) => t.id.startsWith(`${pidA}_`)), 10_000, '刷新后载入 A');
  await waitFor(() => page.$('[data-pc="ai-start"]'), 10_000, 'A 的开始页');
  const s6 = await startState();
  check('S6.A-still-cleared-after-reload', s6.start && !s6.animated && !s6.orb, s6);
  await shot('s6-reload-cleared.png');
  await page.evaluate((p) => window.__pcStore.actions.loadProject(p), projB);
  await waitFor(async () => (await railTabs()).some((t) => !t.draft && t.id.startsWith(`${pidB}_`)), 10_000, '刷新后载入 B');
  const s6b = await railTabs();
  check('S6.B-agent1-restored-after-reload', s6b.length === 1 && s6b[0].label === 'Agent 1', { s6b });

  /* ── S7 减少动效:引导动画全部关掉 ── */
  await page.evaluate(() => window.__pcStore.actions.newProject('项目 C'));
  await waitFor(async () => (await startState()).animated, 8000, 'C 的开始页');
  const anim = () => page.evaluate(() => {
    const name = (sel) => { const n = document.querySelector(sel); return n ? getComputedStyle(n).animationName : null; };
    const composer = [...document.querySelectorAll('[data-pc="ai-composer"]')].find((n) => n.getClientRects().length > 0);
    return { core: name('.pc-start-orb-core'), ring: name('.pc-start-orb-ring'), cue: name('.pc-start-cue'), composer: composer ? getComputedStyle(composer).animationName : null };
  });
  const motionOn = await anim();
  check('S7.animation-runs-normally', Object.values(motionOn).every((v) => v && v !== 'none'), motionOn);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await sleep(300);
  const motionOff = await anim();
  check('S7.reduced-motion-stops-all', Object.values(motionOff).every((v) => v === 'none'), motionOff);

  check('page-errors', pageErrors.length === 0, { pageErrors: pageErrors.slice(0, 5) });
} catch (e) {
  check('probe-ran', false, { error: String(e?.stack ?? e).slice(0, 800) });
} finally {
  try { await browser?.close(); } catch {}
  try { server?.stop(); } catch {}
  if (tmp && !KEEP) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
}
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ summary: { ok: failed.length === 0, passes: results.length - failed.length, fails: failed.map((r) => r.check), shots: OUT } }));
process.exit(failed.length ? 1 : 0);
