/**
 * 在线构建里看 AI 栏的开始页与手机版 Agent 分页(配合 agent-tabs-start-probe.mjs:那支只测桌面编辑台的本机 AI 栏)。
 * 全程在本机:本机托管组合 + 仿 nginx 的代理(`lib/mobile-env.mjs`),在线构建当页面,不连真正的托管端。
 *
 *   npx vite build --mode online
 *   node scripts/probes/agent-tabs-start-mobile-probe.mjs [--dist dist-online] [--out out/agent-tabs-start-mobile-probe] [--base-port 5980] [--doc-port 5983] [--asset-port 5987]
 *
 * 验收(每项一行 JSON,最后一行 { summary },有失败退出码 1):
 *   O1 在线桌面界面(?layout=desktop)的 AI 栏走「云端」接入方式:没有会话时同样是开始页(竖栏「开始」一项、预设按钮),带引导动画。
 *      (这台本机托管组合没有云端 Agent 服务,云端面板的输入框要等对话权限读回来才出现,所以点预设、发送那一段不在这里测;本机 AI 栏的那一段见 agent-tabs-start-probe.mjs。)
 *   M1 手机版(安卓仿真、窄屏):Agent 分页照演示稿重画(`src/mobile/AgentPage.tsx`),没有会话时同桌面一样是开始页:
 *      只有「开始」一项标签、预设按钮、输入框,占满分页、没有页面错误、不白屏;不再是桌面那套云端对话面板。截图 mobile-agent.png。
 *      (点预设、点发送建会话、引用、清空后无动画等在 `mobile-agent-probe.mjs`。)
 */
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { startMobileEnv, emptyProject } from './lib/mobile-env.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.resolve(arg('--dist', path.join(ROOT, 'dist-online')));
const OUT = path.resolve(ROOT, arg('--out', 'out/agent-tabs-start-mobile-probe'));
const BASE = Number(arg('--base-port', 5980));
const DOC = Number(arg('--doc-port', 5983));
const ASSET = Number(arg('--asset-port', 5987));
for (const p of [BASE, BASE + 1, BASE + 2, DOC, ASSET]) if (p < 5980 || p > 5989) throw new Error(`端口 ${p} 不在分给本探针的 5980～5989 里`);
fs.mkdirSync(OUT, { recursive: true });

const PRESET = '做一个动画告诉我使用软件可以干什么';
const results = [];
const check = (name, ok, extra = {}) => { const r = { check: name, ok: !!ok, ...extra }; results.push(r); console.log(JSON.stringify(r)); return !!ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`等 ${what} 超时`);
    await sleep(200);
  }
}

let env = null;
let browser = null;
try {
  env = await startMobileEnv({ dist: DIST, basePort: BASE, docPort: DOC, assetPort: ASSET, name: `agent-tabs-${Date.now().toString(36)}` });
  const seeded = await env.seed(emptyProject('开始页探针'));
  check('seeded', !/error|reject/i.test(`${seeded.opened}${seeded.seeded}`), seeded);
  browser = await puppeteer.launch({ headless: true, protocolTimeout: 600_000, args: [...PROBE_CHROME_ARGS, '--no-first-run'] });

  /* O1 在线桌面界面:云端接入方式的开始页 */
  {
    const p = await env.newPage(browser, 'desktop');
    await env.enter(p, { layout: 'desktop' });
    await waitFor(() => p.$('[data-pc="ai-start"]'), 90_000, '在线桌面界面的开始页');
    await sleep(1000);
    const rail = await p.evaluate(() => [...document.querySelectorAll('nav[data-pc="right-rail"] [data-pc-agent-tab]')].map((b) => ({ draft: b.getAttribute('data-pc-agent-draft') === '1', label: b.querySelector('.pc-rr-label')?.textContent })));
    const st = await p.evaluate(() => ({
      animated: document.querySelector('[data-pc="ai-start"]')?.getAttribute('data-pc-start-animated') === '1',
      orb: !!document.querySelector('[data-pc="ai-start-orb"]'),
      cloudPanel: !!document.querySelector('[data-pc="cloud-ai-panel"]'),
      guide: document.querySelector('[data-pc="ai-composer"]')?.getAttribute('data-pc-guide') ?? null,
    }));
    // 这台本机托管组合没有云端 Agent 服务:云端面板里输入框要等「对话权限」读回来才出现(现有行为),所以这里不点预设、不看输入框,只看开始页本身
    check('O1.cloud-start-page', rail.length === 1 && rail[0].draft && rail[0].label === '开始' && st.animated && st.orb && st.cloudPanel, { rail, st });
    await p.screenshot({ path: path.join(OUT, 'online-desktop-start.png') });
    check('O1.no-page-errors', p.errors.length === 0, { errors: p.errors.slice(0, 3) });
    await p.browserContext().close();
  }

  /* M1 手机版 Agent 分页:2026-10-22 起照演示稿重画,没有会话时也是开始页(同桌面共用 agentTabs;细节见 mobile-agent-probe.mjs) */
  {
    const p = await env.newPage(browser, 'phone');
    await env.enter(p);
    await waitFor(() => p.$('[data-pcm="pg-agent"]'), 90_000, '手机版底部导航栏');
    await sleep(800);
    await p.evaluate(() => document.querySelector('[data-pcm="pg-agent"]').click());
    await waitFor(() => p.evaluate(() => { const e = document.querySelector('[data-pcm="pane-agent"]'); return !!e && e.style.display !== 'none' && !!e.querySelector('[data-pcm="agent-start"]'); }), 30_000, '手机版 Agent 分页里的开始页');
    await sleep(800);
    const m = await p.evaluate(() => {
      const e = document.querySelector('[data-pcm="pane-agent"]');
      const r = e.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), composer: !!e.querySelector('[data-pcm="chat-input"]'), startHero: !!e.querySelector('[data-pcm="agent-start"]'), preset: e.querySelector('[data-pcm="agent-start-preset"]')?.textContent ?? null, tabs: [...e.querySelectorAll('[data-pcm="atab"]')].map((t) => t.querySelector('.nm')?.textContent), oldPanel: !!e.querySelector('.ai-panel'), hasText: e.innerText.trim().length > 0 };
    });
    check('M1.mobile-agent-start-page', m.w > 300 && m.h > 300 && m.startHero && m.composer && m.preset === PRESET && m.tabs.length === 1 && m.tabs[0] === '开始' && !m.oldPanel && m.hasText && p.errors.length === 0, { m, errors: p.errors.slice(0, 3) });
    await p.screenshot({ path: path.join(OUT, 'mobile-agent.png') });
    await p.browserContext().close();
  }
} catch (e) {
  check('probe-ran', false, { error: String(e?.stack ?? e).slice(0, 800) });
} finally {
  try { await browser?.close(); } catch {}
  try { await env?.close(); } catch {}
}
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ summary: { ok: failed.length === 0, passes: results.length - failed.length, fails: failed.map((r) => r.check), shots: OUT } }));
process.exit(failed.length ? 1 : 0);
