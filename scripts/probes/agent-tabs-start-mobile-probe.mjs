/**
 * Verifies AI panel start page and mobile app Agent tab in online build (paired with
 * agent-tabs-start-probe.mjs: that one only tests the local AI panel of desktop editor).
 * Entirely local: local hosted setup + nginx-like proxy (`lib/mobile-env.mjs`), online build served
 * as page, does not connect to the real hosted side.
 *
 *   npx vite build --mode online
 *   node scripts/probes/agent-tabs-start-mobile-probe.mjs [--dist dist-online] [--out out/agent-tabs-start-mobile-probe] [--base-port 5980] [--doc-port 5983] [--asset-port 5987]
 *
 * Acceptance check (one JSON line per item, last line { summary }, exit code 1 on failure):
 *   O1 AI panel in online desktop UI (?layout=desktop) uses "Cloud" connection type: also shows
 *      start page when there are no sessions (single "Start" item on vertical rail, preset buttons),
 *      with guidance animation.
 *      (This local hosted setup has no Cloud Agent service; input box in cloud panel only appears
 *      after chat permissions are read back, so clicking presets and sending are not tested here;
 *      see agent-tabs-start-probe.mjs for the local AI panel part.)
 *   M1 Mobile app (Android emulation, narrow screen): Agent tab redrawn per demo
 *      (`src/mobile/AgentPage.tsx`), like desktop, shows start page when there are no sessions:
 *      only a single "Start" tab, preset buttons, and input box, filling tab with no page errors
 *      and no blank screen; no longer the desktop cloud chat panel. Screenshot: mobile-agent.png.
 *      (Clicking presets, clicking send to create sessions, quotes, no animation after clearing,
 *      etc. are in `mobile-agent-probe.mjs`.)
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
for (const p of [BASE, BASE + 1, BASE + 2, DOC, ASSET]) if (p < 5980 || p > 5989) throw new Error(`Port ${p} is not in the 5980-5989 range assigned to this probe`);
fs.mkdirSync(OUT, { recursive: true });

const PRESET = 'Make an animation that tells me what I can do with the software';
const results = [];
const check = (name, ok, extra = {}) => { const r = { check: name, ok: !!ok, ...extra }; results.push(r); console.log(JSON.stringify(r)); return !!ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`Timed out waiting for ${what}`);
    await sleep(200);
  }
}

let env = null;
let browser = null;
try {
  env = await startMobileEnv({ dist: DIST, basePort: BASE, docPort: DOC, assetPort: ASSET, name: `agent-tabs-${Date.now().toString(36)}` });
  const seeded = await env.seed(emptyProject('Start page probe'));
  check('seeded', !/error|reject/i.test(`${seeded.opened}${seeded.seeded}`), seeded);
  browser = await puppeteer.launch({ headless: true, protocolTimeout: 600_000, args: [...PROBE_CHROME_ARGS, '--no-first-run'] });

  /* O1 Online desktop UI: start page for Cloud connection type */
  {
    const p = await env.newPage(browser, 'desktop');
    await env.enter(p, { layout: 'desktop' });
    await waitFor(() => p.$('[data-pc="ai-start"]'), 90_000, 'start page of the online desktop editor');
    await sleep(1000);
    const rail = await p.evaluate(() => [...document.querySelectorAll('nav[data-pc="right-rail"] [data-pc-agent-tab]')].map((b) => ({ draft: b.getAttribute('data-pc-agent-draft') === '1', label: b.querySelector('.pc-rr-label')?.textContent })));
    const st = await p.evaluate(() => ({
      animated: document.querySelector('[data-pc="ai-start"]')?.getAttribute('data-pc-start-animated') === '1',
      orb: !!document.querySelector('[data-pc="ai-start-orb"]'),
      cloudPanel: !!document.querySelector('[data-pc="cloud-ai-panel"]'),
      guide: document.querySelector('[data-pc="ai-composer"]')?.getAttribute('data-pc-guide') ?? null,
    }));
    // This local hosted setup has no Cloud Agent service: the input box in the cloud panel only
    // appears after "chat permissions" are read back (existing behavior), so here we do not click
    // presets or check the input box, only inspecting the start page itself
    check('O1.cloud-start-page', rail.length === 1 && rail[0].draft && rail[0].label === 'Start' && st.animated && st.orb && st.cloudPanel, { rail, st });
    await p.screenshot({ path: path.join(OUT, 'online-desktop-start.png') });
    check('O1.no-page-errors', p.errors.length === 0, { errors: p.errors.slice(0, 3) });
    await p.browserContext().close();
  }

  /* M1 Mobile app Agent tab: redrawn per demo as of 2026-10-22; also shows start page when
   * there are no sessions (shares agentTabs with desktop; see mobile-agent-probe.mjs for details) */
  {
    const p = await env.newPage(browser, 'phone');
    await env.enter(p);
    await waitFor(() => p.$('[data-pcm="pg-agent"]'), 90_000, 'mobile app bottom navigation bar');
    await sleep(800);
    await p.evaluate(() => document.querySelector('[data-pcm="pg-agent"]').click());
    await waitFor(() => p.evaluate(() => { const e = document.querySelector('[data-pcm="pane-agent"]'); return !!e && e.style.display !== 'none' && !!e.querySelector('[data-pcm="agent-start"]'); }), 30_000, 'start page in the mobile app Agent tab');
    await sleep(800);
    const m = await p.evaluate(() => {
      const e = document.querySelector('[data-pcm="pane-agent"]');
      const r = e.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), composer: !!e.querySelector('[data-pcm="chat-input"]'), startHero: !!e.querySelector('[data-pcm="agent-start"]'), preset: e.querySelector('[data-pcm="agent-start-preset"]')?.textContent ?? null, tabs: [...e.querySelectorAll('[data-pcm="atab"]')].map((t) => t.querySelector('.nm')?.textContent), oldPanel: !!e.querySelector('.ai-panel'), hasText: e.innerText.trim().length > 0 };
    });
    check('M1.mobile-agent-start-page', m.w > 300 && m.h > 300 && m.startHero && m.composer && m.preset === PRESET && m.tabs.length === 1 && m.tabs[0] === 'Start' && !m.oldPanel && m.hasText && p.errors.length === 0, { m, errors: p.errors.slice(0, 3) });
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
